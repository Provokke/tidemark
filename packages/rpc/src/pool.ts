import { metrics } from "@tidemark/core";
import { createHash } from "node:crypto";
import { type LogFilter, logMatches, toRpcLogFilter } from "@tidemark/core";
import {
  AllEndpointsFailedError,
  ChainIdMismatchError,
  InvalidResponseError,
  JsonRpcResponseError,
  LaggingNodeError,
  NotYetAvailableError,
  RangeTooLargeError,
  RpcError,
  classify,
} from "./errors.js";
import { EndpointHealth, TokenBucket } from "./health.js";
import {
  parseBlockHeader,
  parseLog,
  parseReceipt,
  parseTrace,
  parseTransaction,
  quantity,
  toQuantity,
} from "./parse.js";
import { Redactor } from "./redact.js";
import { HttpTransport } from "./transport.js";
import type {
  BlockTag,
  Hex,
  JsonRpcRequest,
  RpcBlockHeader,
  RpcLog,
  RpcReceipt,
  RpcTrace,
  RpcTransaction,
} from "./types.js";

const rpcRequests = metrics.counter(
  "tm_rpc_requests_total",
  "RPC requests by chain, method, endpoint and outcome.",
  ["chain", "method", "endpoint", "outcome"],
);
const rpcSeconds = metrics.histogram("tm_rpc_request_seconds", "RPC request latency by chain and method.", [
  "chain",
  "method",
]);

export interface EndpointConfig {
  readonly url: string;
  /** Requests per second this endpoint may receive. Unlimited when omitted. */
  readonly rps?: number;
}

export type Finality = { readonly kind: "tag" } | { readonly kind: "depth"; readonly depth: number };

export interface RpcPoolOptions {
  readonly chainId: number;
  readonly endpoints: readonly (string | EndpointConfig)[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Passes over the endpoint list before giving up. */
  readonly rounds?: number;
  readonly redactor?: Redactor;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Endpoint {
  /** Stable, non-secret id: position and a short hash of the URL. Safe to log. */
  readonly id: string;
  readonly transport: HttpTransport;
  readonly health: EndpointHealth;
  readonly limiter: TokenBucket | undefined;
  disabled: string | undefined;
  capabilities: EndpointCapabilities | undefined;
}

export interface EndpointCapabilities {
  readonly chainId: number;
  readonly finalizedTag: boolean;
}

export interface EndpointStats {
  readonly id: string;
  readonly calls: number;
  readonly failures: number;
  readonly lags: number;
  readonly rateLimits: number;
  readonly latencyEwmaMs: number;
  readonly errorRate: number;
  readonly open: boolean;
  readonly disabled: string | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The JSON-RPC client for one chain: ordered failover across endpoints, per-endpoint health and
 * rate limits, error classification, and reads that refuse answers from nodes behind the range.
 */
export class RpcPool {
  readonly chainId: number;
  readonly endpoints: readonly Endpoint[];
  readonly redactor: Redactor;
  readonly #rounds: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: RpcPoolOptions) {
    if (options.endpoints.length === 0) throw new Error(`chain ${options.chainId} has no RPC endpoints`);
    this.chainId = options.chainId;
    this.redactor = options.redactor ?? new Redactor();
    this.#rounds = options.rounds ?? 2;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.endpoints = options.endpoints.map((entry, index) => {
      const config = typeof entry === "string" ? { url: entry } : entry;
      this.redactor.register(config.url);
      const id = `${options.chainId}#${index}:${createHash("sha256").update(config.url).digest("hex").slice(0, 8)}`;
      return {
        id,
        transport: new HttpTransport(config.url, {
          timeoutMs: options.timeoutMs ?? 10_000,
          maxResponseBytes: options.maxResponseBytes ?? 10 * 1024 * 1024,
          endpointId: id,
        }),
        health: new EndpointHealth(),
        limiter:
          config.rps === undefined
            ? undefined
            : new TokenBucket(config.rps, Math.max(1, Math.ceil(config.rps)), this.#now, this.#sleep),
        disabled: undefined,
        capabilities: undefined,
      };
    });
  }

  /** Endpoints in the order to try them: enabled, healthiest first, then configured order. */
  #ordered(): Endpoint[] {
    const now = this.#now();
    return this.endpoints
      .map((endpoint, index) => ({ endpoint, index, rank: endpoint.health.rank(now) }))
      .filter((e) => e.endpoint.disabled === undefined)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((e) => e.endpoint);
  }

  /**
   * Runs `fn` against endpoints until one succeeds. A range refusal or a deterministic error is
   * thrown at once; anything else moves to the next endpoint, then the next round after a backoff.
   */
  async #attempt<T>(method: string, fn: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    const causes: string[] = [];
    let onlyLagging = true;
    for (let round = 0; round < this.#rounds; round++) {
      const endpoints = this.#ordered();
      if (endpoints.length === 0) break;
      for (const endpoint of endpoints) {
        if (
          endpoint.health.isOpen(this.#now()) &&
          round === 0 &&
          endpoints.some((e) => !e.health.isOpen(this.#now()))
        ) {
          continue; // a closed endpoint exists this round; skip open breakers until the next
        }
        await endpoint.limiter?.take();
        const started = this.#now();
        try {
          const result = await fn(endpoint);
          endpoint.health.success(this.#now() - started);
          rpcRequests.inc({ chain: this.chainId, method, endpoint: endpoint.id, outcome: "ok" });
          rpcSeconds.observe({ chain: this.chainId, method }, (this.#now() - started) / 1000);
          return result;
        } catch (error) {
          const c = classify(error, method);
          rpcRequests.inc({ chain: this.chainId, method, endpoint: endpoint.id, outcome: c.kind });
          endpoint.health.failure(c.kind, this.#now(), c.retryAfterMs);
          if (error instanceof ChainIdMismatchError) endpoint.disabled = error.message;
          if (c.kind === "range") {
            throw new RangeTooLargeError(c.suggestedSize, endpoint.id, { cause: this.#redacted(error) });
          }
          if (c.kind === "fatal") throw this.#redacted(error);
          if (c.kind !== "lag") onlyLagging = false;
          causes.push(`${endpoint.id}: ${this.#describe(error)}`);
        }
      }
      if (round < this.#rounds - 1) await this.#sleep(200 * 2 ** round + Math.floor(Math.random() * 100));
    }
    if (onlyLagging && causes.length > 0) {
      throw new NotYetAvailableError(`${method}: every endpoint is behind the requested block`);
    }
    throw new AllEndpointsFailedError(method, causes);
  }

  #describe(error: unknown): string {
    return this.redactor.redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  #redacted(error: unknown): Error {
    if (error instanceof RpcError) {
      error.message = this.redactor.redact(error.message);
      return error;
    }
    return new RpcError(this.#describe(error));
  }

  /** One JSON-RPC call with failover. */
  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    return this.#attempt(method, (endpoint) => endpoint.transport.request({ method, params }));
  }

  /**
   * Requests sent as one batch to a single endpoint, failing over as a unit. A JSON-RPC error on
   * any element fails the attempt on that endpoint.
   */
  async batch(requests: readonly JsonRpcRequest[]): Promise<unknown[]> {
    if (requests.length === 0) return [];
    const method = requests.length === 1 ? (requests[0]?.method ?? "batch") : "batch";
    return this.#attempt(method, async (endpoint) => {
      const results = await endpoint.transport.batch(requests);
      for (const result of results) if (result instanceof JsonRpcResponseError) throw result;
      return results;
    });
  }

  async blockNumber(): Promise<number> {
    return this.#attempt("eth_blockNumber", async (endpoint) => {
      const head = quantity(
        await endpoint.transport.request({ method: "eth_blockNumber", params: [] }),
        "head",
      );
      endpoint.health.observeHead(head);
      return head;
    });
  }

  async getBlockHeader(block: number | BlockTag): Promise<RpcBlockHeader> {
    const ref = typeof block === "number" ? toQuantity(block) : block;
    return this.#attempt("eth_getBlockByNumber", async (endpoint) => {
      const raw = await endpoint.transport.request({ method: "eth_getBlockByNumber", params: [ref, false] });
      if (raw === null) {
        if (typeof block === "number")
          throw new LaggingNodeError(endpoint.health.lastHead ?? -1, block, endpoint.id);
        throw new InvalidResponseError(`node has no "${block}" block`, endpoint.id);
      }
      return parseBlockHeader(raw);
    });
  }

  /**
   * Headers for the given block numbers, batched. Each batch goes to one endpoint; an endpoint
   * missing any of them (behind, or pruned) fails over as a unit.
   */
  async getBlockHeaders(numbers: readonly number[], batchSize = 50): Promise<RpcBlockHeader[]> {
    const out: RpcBlockHeader[] = [];
    for (let i = 0; i < numbers.length; i += batchSize) {
      const chunk = numbers.slice(i, i + batchSize);
      const headers = await this.#attempt("eth_getBlockByNumber", async (endpoint) => {
        const results = await endpoint.transport.batch(
          chunk.map((n) => ({ method: "eth_getBlockByNumber", params: [toQuantity(n), false] })),
        );
        return results.map((raw, j) => {
          if (raw instanceof JsonRpcResponseError) throw raw;
          const wanted = chunk[j] ?? -1;
          if (raw === null) throw new LaggingNodeError(endpoint.health.lastHead ?? -1, wanted, endpoint.id);
          const header = parseBlockHeader(raw);
          if (header.number !== wanted) {
            throw new InvalidResponseError(`asked for block ${wanted}, got ${header.number}`, endpoint.id);
          }
          return header;
        });
      });
      out.push(...headers);
    }
    return out;
  }

  /** A header by hash. A node that does not have the block counts as lagging and fails over. */
  async getBlockHeaderByHash(hash: Hex): Promise<RpcBlockHeader> {
    return this.#attempt("eth_getBlockByHash", async (endpoint) => {
      const raw = await endpoint.transport.request({ method: "eth_getBlockByHash", params: [hash, false] });
      if (raw === null) throw new LaggingNodeError(endpoint.health.lastHead ?? -1, -1, endpoint.id);
      const header = parseBlockHeader(raw);
      if (header.hash !== hash.toLowerCase())
        throw new InvalidResponseError(`asked for block ${hash}, got ${header.hash}`, endpoint.id);
      return header;
    });
  }

  /**
   * The logs of one block, by its hash, for each filter. The header and the logs are read in one
   * batch from one node, and a node that does not know the block fails over, since some nodes
   * answer `eth_getLogs` for an unknown block hash with an empty list instead of an error. Every
   * log must carry the requested block hash and match its filter.
   */
  async getBlockLogs(hash: Hex, filters: readonly LogFilter[]): Promise<RpcLog[][]> {
    if (filters.length === 0) return [];
    return this.#attempt("eth_getLogs", async (endpoint) => {
      const results = await endpoint.transport.batch([
        { method: "eth_getBlockByHash", params: [hash, false] },
        ...filters.map((filter) => {
          const { fromBlock: _from, toBlock: _to, ...rest } = toRpcLogFilter(filter, 0, 0);
          return { method: "eth_getLogs", params: [{ ...rest, blockHash: hash }] };
        }),
      ]);
      const [block, ...logLists] = results;
      if (block instanceof JsonRpcResponseError) throw block;
      if (block === null) throw new LaggingNodeError(endpoint.health.lastHead ?? -1, -1, endpoint.id);
      return logLists.map((raw, i) => {
        if (raw instanceof JsonRpcResponseError) throw raw;
        if (!Array.isArray(raw))
          throw new InvalidResponseError("eth_getLogs result is not an array", endpoint.id);
        const filter = filters[i] as LogFilter;
        const logs = raw.map(parseLog);
        for (const log of logs) {
          if (log.blockHash !== hash.toLowerCase())
            throw new InvalidResponseError(`log from block ${log.blockHash}, asked for ${hash}`, endpoint.id);
          if (!logMatches(filter, log))
            throw new InvalidResponseError("log does not match the filter", endpoint.id);
        }
        return logs.sort((a, b) => a.logIndex - b.logIndex);
      });
    });
  }

  /** The newest block the chain treats as final, per the configured finality. Never guessed. */
  async finalizedBlock(finality: Finality): Promise<RpcBlockHeader> {
    if (finality.kind === "tag") return this.getBlockHeader("finalized");
    const head = await this.blockNumber();
    return this.getBlockHeader(Math.max(0, head - finality.depth));
  }

  /**
   * `eth_getLogs` that only accepts an answer from a node whose head covers the range.
   *
   * The read is sent in one batch with `eth_blockNumber` to one node, and counts only if that head
   * is at or past `toBlock`. Erigon, Besu and reth answer a range past their head with fewer logs
   * instead of an error, so a lagging failover node must not be able to return a short answer.
   * Erigon may run batch entries concurrently, so a node whose last known head is below the range
   * is asked for its head on its own first. (Credit: Blockwarden's monitor.)
   *
   * Every returned log is checked to be inside the range and to match the filter, and the result
   * is sorted and de-duplicated.
   */
  async getLogs(filter: LogFilter, fromBlock: number, toBlock: number): Promise<RpcLog[]> {
    if (filter.chainId !== this.chainId)
      throw new Error(`filter is for chain ${filter.chainId}, pool for ${this.chainId}`);
    const rpcFilter = toRpcLogFilter(filter, fromBlock, toBlock);
    return this.#attempt("eth_getLogs", async (endpoint) => {
      if ((endpoint.health.lastHead ?? -1) < toBlock) {
        const head = quantity(
          await endpoint.transport.request({ method: "eth_blockNumber", params: [] }),
          "head",
        );
        endpoint.health.observeHead(head);
        if (head < toBlock) throw new LaggingNodeError(head, toBlock, endpoint.id);
      }
      const [headRaw, logsRaw] = await endpoint.transport.batch([
        { method: "eth_blockNumber", params: [] },
        { method: "eth_getLogs", params: [rpcFilter] },
      ]);
      if (logsRaw instanceof JsonRpcResponseError) throw logsRaw;
      if (headRaw instanceof JsonRpcResponseError) throw headRaw;
      const head = quantity(headRaw, "head");
      endpoint.health.observeHead(head);
      if (head < toBlock) throw new LaggingNodeError(head, toBlock, endpoint.id);
      if (!Array.isArray(logsRaw))
        throw new InvalidResponseError("eth_getLogs result is not an array", endpoint.id);

      const seen = new Set<string>();
      const logs: RpcLog[] = [];
      for (const raw of logsRaw) {
        const log = parseLog(raw);
        if (log.blockNumber < fromBlock || log.blockNumber > toBlock) {
          throw new InvalidResponseError(
            `log at block ${log.blockNumber} is outside ${fromBlock}-${toBlock}`,
            endpoint.id,
          );
        }
        if (!logMatches(filter, log))
          throw new InvalidResponseError("log does not match the filter", endpoint.id);
        const key = `${log.blockNumber}:${log.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        logs.push(log);
      }
      return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    });
  }

  /**
   * Calls to `to` addresses in a block range via `trace_filter`, head-checked like `getLogs`.
   * Sorted by transaction, then depth-first position in the call tree.
   */
  async traceFilter(to: readonly Hex[], fromBlock: number, toBlock: number): Promise<RpcTrace[]> {
    const filter = { fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock), toAddress: [...to] };
    return this.#attempt("trace_filter", async (endpoint) => {
      if ((endpoint.health.lastHead ?? -1) < toBlock) {
        const head = quantity(
          await endpoint.transport.request({ method: "eth_blockNumber", params: [] }),
          "head",
        );
        endpoint.health.observeHead(head);
        if (head < toBlock) throw new LaggingNodeError(head, toBlock, endpoint.id);
      }
      const [headRaw, tracesRaw] = await endpoint.transport.batch([
        { method: "eth_blockNumber", params: [] },
        { method: "trace_filter", params: [filter] },
      ]);
      if (tracesRaw instanceof JsonRpcResponseError) throw tracesRaw;
      if (headRaw instanceof JsonRpcResponseError) throw headRaw;
      const head = quantity(headRaw, "head");
      endpoint.health.observeHead(head);
      if (head < toBlock) throw new LaggingNodeError(head, toBlock, endpoint.id);
      if (!Array.isArray(tracesRaw))
        throw new InvalidResponseError("trace_filter result is not an array", endpoint.id);
      const traces = tracesRaw.map(parseTrace);
      for (const t of traces) {
        if (t.blockNumber < fromBlock || t.blockNumber > toBlock) {
          throw new InvalidResponseError(
            `trace at block ${t.blockNumber} is outside ${fromBlock}-${toBlock}`,
            endpoint.id,
          );
        }
      }
      return sortTraces(traces);
    });
  }

  /** Every trace of one transaction, in depth-first order. */
  async traceTransaction(hash: Hex): Promise<RpcTrace[]> {
    return this.#attempt("trace_transaction", async (endpoint) => {
      const raw = await endpoint.transport.request({ method: "trace_transaction", params: [hash] });
      if (raw === null) throw new LaggingNodeError(endpoint.health.lastHead ?? -1, -1, endpoint.id);
      if (!Array.isArray(raw))
        throw new InvalidResponseError("trace_transaction result is not an array", endpoint.id);
      return sortTraces(raw.map(parseTrace));
    });
  }

  /** Every trace of one block, checked to belong to the block with this hash. */
  async traceBlock(header: { number: number; hash: Hex }): Promise<RpcTrace[]> {
    return this.#attempt("trace_block", async (endpoint) => {
      const raw = await endpoint.transport.request({
        method: "trace_block",
        params: [toQuantity(header.number)],
      });
      if (raw === null)
        throw new LaggingNodeError(endpoint.health.lastHead ?? -1, header.number, endpoint.id);
      if (!Array.isArray(raw))
        throw new InvalidResponseError("trace_block result is not an array", endpoint.id);
      const traces = raw.map(parseTrace).filter((t) => t.type !== "reward");
      for (const t of traces) {
        // A node on another branch answers for a different block at this height: treat as behind.
        if (t.blockHash !== header.hash.toLowerCase())
          throw new LaggingNodeError(-1, header.number, endpoint.id);
      }
      return sortTraces(traces);
    });
  }

  /** Transactions and their receipts by hash, read in one batch from one node. */
  async getTransactions(
    hashes: readonly Hex[],
    batchSize = 50,
  ): Promise<{ transaction: RpcTransaction; receipt: RpcReceipt }[]> {
    const out: { transaction: RpcTransaction; receipt: RpcReceipt }[] = [];
    for (let i = 0; i < hashes.length; i += batchSize) {
      const chunk = hashes.slice(i, i + batchSize);
      const results = await this.#attempt("eth_getTransactionReceipt", async (endpoint) => {
        const raw = await endpoint.transport.batch(
          chunk.flatMap((hash) => [
            { method: "eth_getTransactionByHash", params: [hash] },
            { method: "eth_getTransactionReceipt", params: [hash] },
          ]),
        );
        return chunk.map((hash, j) => {
          const [tx, receipt] = [raw[2 * j], raw[2 * j + 1]];
          if (tx instanceof JsonRpcResponseError) throw tx;
          if (receipt instanceof JsonRpcResponseError) throw receipt;
          if (tx === null || receipt === null)
            throw new LaggingNodeError(endpoint.health.lastHead ?? -1, -1, endpoint.id);
          const parsed = { transaction: parseTransaction(tx), receipt: parseReceipt(receipt) };
          if (
            parsed.transaction.hash !== hash.toLowerCase() ||
            parsed.receipt.blockHash !== parsed.transaction.blockHash
          ) {
            throw new InvalidResponseError(`inconsistent transaction and receipt for ${hash}`, endpoint.id);
          }
          return parsed;
        });
      });
      out.push(...results);
    }
    return out;
  }

  /** `eth_call` (or another read) at a block number or a block hash (EIP-1898). */
  async readAt(
    method: "eth_call" | "eth_getBalance" | "eth_getCode" | "eth_getStorageAt",
    params: readonly unknown[],
    block: number | { blockHash: Hex },
  ): Promise<unknown> {
    const ref =
      typeof block === "number" ? toQuantity(block) : { blockHash: block.blockHash, requireCanonical: true };
    return this.request(method, [...params, ref]);
  }

  /**
   * Checks every endpoint's chain id and finality-tag support. An endpoint on the wrong chain is
   * disabled: it would otherwise feed another chain's logs into this chain's cache.
   */
  async probe(): Promise<Map<string, EndpointCapabilities | Error>> {
    const results = new Map<string, EndpointCapabilities | Error>();
    await Promise.all(
      this.endpoints.map(async (endpoint) => {
        try {
          const chainId = quantity(
            await endpoint.transport.request({ method: "eth_chainId", params: [] }),
            "chainId",
          );
          if (chainId !== this.chainId) {
            endpoint.disabled = `reports chain ${chainId}, configured for ${this.chainId}`;
            throw new ChainIdMismatchError(endpoint.disabled, endpoint.id);
          }
          let finalizedTag = false;
          try {
            const raw = await endpoint.transport.request({
              method: "eth_getBlockByNumber",
              params: ["finalized", false],
            });
            finalizedTag = raw !== null;
          } catch {
            finalizedTag = false;
          }
          endpoint.capabilities = { chainId, finalizedTag };
          results.set(endpoint.id, endpoint.capabilities);
        } catch (error) {
          results.set(endpoint.id, this.#redacted(error));
        }
      }),
    );
    return results;
  }

  stats(): EndpointStats[] {
    const now = this.#now();
    return this.endpoints.map((e) => ({
      id: e.id,
      calls: e.health.calls,
      failures: e.health.failures,
      lags: e.health.lags,
      rateLimits: e.health.rateLimits,
      latencyEwmaMs: e.health.latencyEwmaMs,
      errorRate: e.health.errorRate,
      open: e.health.isOpen(now),
      disabled: e.disabled,
    }));
  }
}

function compareAddress(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Transaction order, then depth-first (pre-order) position in each transaction's call tree. */
function sortTraces(traces: RpcTrace[]): RpcTrace[] {
  return traces.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      compareAddress(a.traceAddress, b.traceAddress),
  );
}
