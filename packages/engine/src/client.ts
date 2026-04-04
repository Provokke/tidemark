import { createHash } from "node:crypto";
import type { RpcPool } from "@tidemark/rpc";
import type { SyncStore } from "@tidemark/sync";
import { type Abi, decodeFunctionResult, encodeFunctionData } from "viem";
import type { Hex } from "./config.js";
import type { ContextClient } from "./registry.js";

type Method = "eth_call" | "eth_getBalance" | "eth_getCode" | "eth_getStorageAt";

/** Reads above finality, by block hash, kept in memory only. Bounded. */
class UnfinalizedCache {
  readonly #entries = new Map<string, unknown>();
  get(key: string): unknown {
    return this.#entries.get(key);
  }
  set(key: string, value: unknown): void {
    if (this.#entries.size >= 10_000) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, value);
  }
}

export interface ReadCounter {
  rpc: number;
  cached: number;
}

/**
 * Builds `context.client` for an event's block. A finalised block is read by number and cached in
 * `tm_sync.rpc_cache`, so the same read during a re-index never reaches the RPC. A block above
 * finality is read by its hash (EIP-1898), so a reorg cannot change the answer under the handler,
 * and cached in memory only.
 */
export class ContextClients {
  readonly #pool: RpcPool;
  readonly #store: SyncStore;
  readonly #unfinalized = new UnfinalizedCache();
  readonly counter: ReadCounter = { rpc: 0, cached: 0 };

  constructor(pool: RpcPool, store: SyncStore) {
    this.#pool = pool;
    this.#store = store;
  }

  at(block: { number: number; hash: Hex; finalized: boolean }): ContextClient {
    const read = async (method: Method, params: readonly unknown[]): Promise<unknown> => {
      // The block hash is part of the key: if a block that was called final is ever replaced (a
      // finality setting that is too shallow, a misbehaving RPC), its cached reads cannot answer
      // for the block that replaced it.
      const key = createHash("sha256")
        .update(JSON.stringify([method, params, block.hash]))
        .digest("hex");
      if (block.finalized) {
        const cached = await this.#store.getCachedRead(this.#pool.chainId, block.number, key);
        if (cached !== undefined) {
          this.counter.cached++;
          return cached;
        }
        this.counter.rpc++;
        const result = await this.#pool.readAt(method, params, block.number);
        await this.#store.putCachedRead(this.#pool.chainId, block.number, key, result);
        return result;
      }
      const memoKey = `${block.hash}:${key}`;
      const memo = this.#unfinalized.get(memoKey);
      if (memo !== undefined) {
        this.counter.cached++;
        return memo;
      }
      this.counter.rpc++;
      const result = await this.#pool.readAt(method, params, { blockHash: block.hash });
      this.#unfinalized.set(memoKey, result);
      return result;
    };

    return {
      async readContract({ address, abi, functionName, args }) {
        const data = encodeFunctionData({ abi: abi as Abi, functionName, args: args as unknown[] } as never);
        const result = (await read("eth_call", [{ to: address, data }])) as Hex;
        const decoded = decodeFunctionResult({
          abi: abi as Abi,
          functionName,
          data: result,
        } as never) as unknown;
        return lowercaseAddresses(decoded);
      },
      async call({ to, data }) {
        return (await read("eth_call", [{ to, data }])) as Hex;
      },
      async getBalance(address) {
        return BigInt((await read("eth_getBalance", [address])) as string);
      },
      async getCode(address) {
        return (await read("eth_getCode", [address])) as Hex;
      },
      async getStorageAt(address, slot) {
        return (await read("eth_getStorageAt", [address, slot])) as Hex;
      },
    };
  }
}

const CHECKSUMMED = /^0x[0-9a-fA-F]{40}$/;

/** viem checksums addresses in results; Tidemark hands handlers lowercase hex, everywhere. */
function lowercaseAddresses(value: unknown): unknown {
  if (typeof value === "string" && CHECKSUMMED.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowercaseAddresses);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, lowercaseAddresses(v)]),
    );
  }
  return value;
}
