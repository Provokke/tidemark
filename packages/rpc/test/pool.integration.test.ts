import { normalizeLogFilter } from "@tidemark/core";
import { emitterAbi, emitterBytecode } from "@tidemark/contracts";
import { type Anvil, type RpcProxy, startAnvil, startRpcProxy } from "@tidemark/testing";
import type { Address } from "viem";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AllEndpointsFailedError,
  NotYetAvailableError,
  RangeTooLargeError,
  RpcPool,
  type RpcPoolOptions,
} from "../src/index.js";

const CHAIN_ID = 31_337;
let anvil: Anvil;
let emitter: Address;
const proxies: RpcProxy[] = [];

async function proxy(faults: Parameters<typeof startRpcProxy>[0]["faults"] = {}, seed = 1) {
  const p = await startRpcProxy({ target: anvil.rpcUrl, faults, seed });
  proxies.push(p);
  return p;
}

const pool = (endpoints: string[], extra: Partial<RpcPoolOptions> = {}) =>
  new RpcPool({
    chainId: CHAIN_ID,
    endpoints,
    timeoutMs: 2_000,
    rounds: 1,
    sleep: () => Promise.resolve(),
    ...extra,
  });

const filter = () =>
  normalizeLogFilter({ chainId: CHAIN_ID, address: emitter.toLowerCase() as `0x${string}` });

beforeAll(async () => {
  anvil = await startAnvil({ chainId: CHAIN_ID });
  const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
  const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
  emitter = receipt.contractAddress as Address;
  // 40 blocks with one or more events each, so ranges have something to lose.
  for (let i = 0; i < 40; i++) {
    const tx = await anvil.walletClient.writeContract({
      address: emitter,
      abi: emitterAbi,
      functionName: "emitMany",
      args: ["0x000000000000000000000000000000000000dEaD", BigInt(1 + (i % 3))],
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: tx });
  }
});

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.stop()));
});

afterAll(async () => {
  await anvil.stop();
});

describe("head-checked eth_getLogs", () => {
  it("the fault proxy really does answer a lagging read with fewer logs and no error", async () => {
    const lagging = await proxy({ lagBlocks: 10 });
    const head = Number(await anvil.publicClient.getBlockNumber());
    const body = (await (
      await fetch(lagging.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [{ address: emitter, fromBlock: "0x0", toBlock: `0x${head.toString(16)}` }],
        }),
      })
    ).json()) as { result: unknown[] };
    const all = await anvil.publicClient.getLogs({ address: emitter, fromBlock: 0n, toBlock: BigInt(head) });
    expect(body.result.length).toBeGreaterThan(0);
    expect(body.result.length).toBeLessThan(all.length);
  });

  it("skips a lagging node and reads the complete range from the next one", async () => {
    const lagging = await proxy({ lagBlocks: 10 });
    const healthy = await proxy();
    const head = Number(await anvil.publicClient.getBlockNumber());
    const rpc = pool([lagging.url, healthy.url]);

    const logs = await rpc.getLogs(filter(), 0, head);
    const all = await anvil.publicClient.getLogs({ address: emitter, fromBlock: 0n, toBlock: BigInt(head) });
    expect(logs).toHaveLength(all.length);
    expect(logs.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(
      all.map((l) => `${Number(l.blockNumber)}:${l.logIndex}`),
    );
    expect(lagging.totalCalls("eth_getLogs")).toBe(0); // the pre-read caught it before any logs were read
    expect(rpc.stats()[0]?.lags).toBe(1);
  });

  it("reports NotYetAvailable, never a short answer, when every node lags", async () => {
    const a = await proxy({ lagBlocks: 3 });
    const b = await proxy({ lagBlocks: 7 });
    const head = Number(await anvil.publicClient.getBlockNumber());
    await expect(pool([a.url, b.url]).getLogs(filter(), 0, head)).rejects.toBeInstanceOf(
      NotYetAvailableError,
    );
    // Below every node's head, the same pool answers.
    expect((await pool([a.url, b.url]).getLogs(filter(), 0, head - 7)).length).toBeGreaterThan(0);
  });

  it("catches a node that falls behind between the pre-read and the batch", async () => {
    const node = await proxy();
    const head = Number(await anvil.publicClient.getBlockNumber());
    const rpc = pool([node.url]);
    await rpc.blockNumber(); // the pool now believes the head covers the range
    node.faults = { lagBlocks: 5 };
    await expect(rpc.getLogs(filter(), 0, head)).rejects.toBeInstanceOf(NotYetAvailableError);
    expect(node.totalCalls("eth_getLogs")).toBe(1); // the batch ran, and its head check refused it
  });
});

describe("range refusals", () => {
  it.each([
    ["alchemy", 8],
    ["infura", 8],
    ["plain", 8],
    ["http-413", undefined],
  ] as const)("%s style becomes RangeTooLargeError with suggestion %s", async (style, suggested) => {
    const node = await proxy({ maxLogRange: 8, rangeErrorStyle: style });
    const error = await pool([node.url])
      .getLogs(filter(), 0, 30)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeTooLargeError);
    expect((error as RangeTooLargeError).suggestedSize).toBe(suggested);
  });

  it("treats a response over the size limit as a range refusal", async () => {
    const node = await proxy();
    const error = await pool([node.url], { maxResponseBytes: 2_000 })
      .getLogs(filter(), 0, 30)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeTooLargeError);
  });
});

describe("failover", () => {
  it.each([
    ["HTTP 500", { failRate: 1 }],
    ["HTTP 429", { rateLimitRate: 1 }],
    ["garbled JSON", { garbleRate: 1 }],
    ["no batch support", { noBatch: true }],
  ])("moves past %s to a healthy endpoint", async (_, faults) => {
    const bad = await proxy(faults);
    const good = await proxy();
    const rpc = pool([bad.url, good.url]);
    const head = await rpc.blockNumber();
    expect(head).toBeGreaterThan(0);
    expect((await rpc.getLogs(filter(), 0, head)).length).toBeGreaterThan(0);
    expect(rpc.stats()[0]?.failures).toBeGreaterThan(0);
  });

  it("times out a hung endpoint and fails over", async () => {
    const hung = await proxy({ hangRate: 1 });
    const good = await proxy();
    const rpc = pool([hung.url, good.url], { timeoutMs: 200 });
    expect(await rpc.blockNumber()).toBeGreaterThan(0);
  });

  it("demotes a failing endpoint behind a healthy one", async () => {
    const bad = await proxy({ failRate: 1 });
    const good = await proxy();
    const rpc = pool([bad.url, good.url]);
    for (let i = 0; i < 5; i++) await rpc.blockNumber();
    // The breaker opened after three failures, so the bad endpoint stopped being tried first.
    expect(bad.totalCalls()).toBeLessThan(5);
  });

  it("gives up with every cause, redacted, when nothing works", async () => {
    const bad = await proxy({ failRate: 1 });
    const secretUrl = `${bad.url}/v2/SuperSecretProviderKey123`;
    const error = await pool([secretUrl])
      .blockNumber()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    expect((error as Error).message).not.toContain("SuperSecretProviderKey123");
    expect((error as AllEndpointsFailedError).causes).toHaveLength(1);
  });
});

describe("probe", () => {
  it("disables an endpoint that reports another chain", async () => {
    const wrong = await proxy({ chainId: 1 });
    const right = await proxy();
    const rpc = pool([wrong.url, right.url]);
    const result = await rpc.probe();
    expect([...result.values()][0]).toBeInstanceOf(Error);
    expect([...result.values()][1]).toEqual({ chainId: CHAIN_ID, finalizedTag: true });
    expect(rpc.stats()[0]?.disabled).toMatch(/chain 1/);
    await rpc.blockNumber();
    expect(wrong.totalCalls("eth_blockNumber")).toBe(0);
  });

  it("reads finality by tag and by depth", async () => {
    const rpc = pool([anvil.rpcUrl]);
    const head = await rpc.blockNumber();
    expect((await rpc.finalizedBlock({ kind: "tag" })).number).toBe(Math.max(0, head - 64)); // Anvil: head - 64, floored at 0
    expect((await rpc.finalizedBlock({ kind: "depth", depth: 5 })).number).toBe(head - 5);
  });

  it("fetches headers in batches and checks the numbers", async () => {
    const rpc = pool([anvil.rpcUrl]);
    const headers = await rpc.getBlockHeaders([1, 2, 3, 10, 20], 2);
    expect(headers.map((h) => h.number)).toEqual([1, 2, 3, 10, 20]);
    expect(headers[1]?.parentHash).toBe(headers[0]?.hash);
  });
});
