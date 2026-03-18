import { type Hex, type LogFilter, logFilterHash, normalizeLogFilter } from "@tidemark/core";
import { emitterAbi, emitterBytecode } from "@tidemark/contracts";
import { connect } from "@tidemark/pg";
import { type RpcBlockHeader, RpcPool } from "@tidemark/rpc";
import { type Anvil, type RpcFaults, createTestDatabase, startAnvil, startRpcProxy } from "@tidemark/testing";
import fc from "fast-check";
import { type Address, toEventSelector } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HistoricalSync, type LogSource, SyncStore } from "../src/index.js";

const CHAIN_ID = 31_337;
let anvil: Anvil;
let emitters: [Address, Address];
let finalized: number;

const SIMPLE = toEventSelector("Simple(address,address,uint256)");
const NO_ARGS = toEventSelector("NoArgs()");

beforeAll(async () => {
  anvil = await startAnvil({ chainId: CHAIN_ID });
  const deploy = async () => {
    const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
    return (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };
  emitters = [await deploy(), await deploy()];

  // 150 blocks: some empty, some with several logs from either emitter, of two event types.
  const rand = fc.sample(fc.tuple(fc.nat(3), fc.nat(1), fc.boolean()), { numRuns: 150, seed: 42 });
  for (const [count, which, noArgs] of rand) {
    if (count === 0) {
      await anvil.testClient.mine({ blocks: 1 });
      continue;
    }
    const address = emitters[which] as Address;
    const hash = noArgs
      ? await anvil.walletClient.writeContract({ address, abi: emitterAbi, functionName: "emitNoArgs" })
      : await anvil.walletClient.writeContract({
          address,
          abi: emitterAbi,
          functionName: "emitMany",
          args: ["0x000000000000000000000000000000000000dEaD", BigInt(count)],
        });
    await anvil.publicClient.waitForTransactionReceipt({ hash });
  }
  await anvil.testClient.mine({ blocks: 64 });
  finalized = Number((await anvil.publicClient.getBlock({ blockTag: "finalized" })).number);
}, 120_000);

afterAll(async () => {
  await anvil.stop();
});

/** What the chain says, straight from Anvil's own eth_getLogs, for comparison. */
async function truth(filter: LogFilter, from: number, to: number) {
  const raw = await anvil.publicClient.request<{
    Method: "eth_getLogs";
    Parameters: [Record<string, unknown>];
    ReturnType: { blockNumber: string; logIndex: string; transactionHash: string; data: string }[];
  }>({
    method: "eth_getLogs",
    params: [
      {
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        ...(filter.address === null ? {} : { address: [...filter.address] }),
        ...(filter.topics[0] === null ? {} : { topics: [[...filter.topics[0]]] }),
      },
    ],
  });
  // Anvil applies the filter; the topic1-3 positions are always wildcards in these tests.
  expect(filter.topics.slice(1).every((t) => t === null)).toBe(true);
  return raw.map((l) => ({
    blockNumber: Number.parseInt(l.blockNumber, 16),
    logIndex: Number.parseInt(l.logIndex, 16),
    transactionHash: l.transactionHash,
    data: l.data,
  }));
}

const lower = (address: Address): Hex => `0x${address.slice(2).toLowerCase()}`;

const filterArb = () =>
  fc.constantFrom<(addresses: [Address, Address]) => LogFilter>(
    ([a]) => normalizeLogFilter({ chainId: CHAIN_ID, address: lower(a) }),
    ([a, b]) => normalizeLogFilter({ chainId: CHAIN_ID, address: [lower(a), lower(b)] }),
    ([, b]) => normalizeLogFilter({ chainId: CHAIN_ID, address: lower(b), topics: [SIMPLE] }),
    () => normalizeLogFilter({ chainId: CHAIN_ID, topics: [[SIMPLE, NO_ARGS]] }),
    () => normalizeLogFilter({ chainId: CHAIN_ID, topics: [NO_ARGS] }),
  );

const faultsArb: fc.Arbitrary<RpcFaults> = fc.record(
  {
    maxLogRange: fc.integer({ min: 1, max: 80 }),
    rangeErrorStyle: fc.constantFrom("alchemy", "infura", "plain", "http-413"),
    failRate: fc.double({ min: 0, max: 0.3, noNaN: true }),
    garbleRate: fc.double({ min: 0, max: 0.1, noNaN: true }),
  },
  { requiredKeys: [] },
);

describe("historical sync", () => {
  it("caches exactly the chain's logs under any faults, and a second run fetches nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ filter: filterArb(), start: fc.nat(), span: fc.option(fc.nat()) }), {
          minLength: 1,
          maxLength: 4,
        }),
        faultsArb,
        fc.boolean(),
        fc.integer({ min: 1, max: 2_000 }),
        fc.nat(),
        async (picks, faults, withLaggingNode, maxLogRange, seed) => {
          const db = await createTestDatabase();
          const sql = connect(db.url, { max: 4 });
          const flaky = await startRpcProxy({ target: anvil.rpcUrl, faults, seed });
          // A healthy endpoint that shares the flaky one's range limit, as two keys of one provider.
          const steady = await startRpcProxy({
            target: anvil.rpcUrl,
            faults: { ...(faults.maxLogRange === undefined ? {} : { maxLogRange: faults.maxLogRange }) },
          });
          const lagging = await startRpcProxy({ target: anvil.rpcUrl, faults: { lagBlocks: 200 } });
          try {
            const store = new SyncStore(sql);
            await store.migrate();
            const sources: LogSource[] = picks.map((p) => {
              const startBlock = p.start % (finalized + 1);
              const endBlock = p.span === null ? undefined : startBlock + (p.span % 50);
              return {
                filter: p.filter(emitters),
                startBlock,
                ...(endBlock === undefined ? {} : { endBlock }),
              };
            });
            const endpoints = withLaggingNode
              ? [lagging.url, flaky.url, steady.url]
              : [flaky.url, steady.url];
            const pool = () =>
              new RpcPool({ chainId: CHAIN_ID, endpoints, timeoutMs: 2_000, sleep: () => Promise.resolve() });
            const report = await new HistoricalSync({ pool: pool(), store, sources, maxLogRange }).run(
              finalized,
            );
            expect(report.incomplete).toBe(false);

            for (const source of sources) {
              const to = Math.min(source.endBlock ?? finalized, finalized);
              const stored = await store.readLogs(source.filter, source.startBlock, to);
              const expected = await truth(source.filter, source.startBlock, to);
              expect(
                stored.map((l) => ({
                  blockNumber: l.blockNumber,
                  logIndex: l.logIndex,
                  transactionHash: l.transactionHash,
                  data: l.data,
                })),
              ).toEqual(expected);
              const cached = await store.cachedIntervals(CHAIN_ID, logFilterHash(source.filter));
              expect(cached.some(([s, e]) => s <= source.startBlock && e >= to)).toBe(true);
            }

            for (const p of [flaky, steady, lagging]) p.resetCalls();
            const second = await new HistoricalSync({ pool: pool(), store, sources, maxLogRange }).run(
              finalized,
            );
            expect(second.filters.every((f) => f.fetchedRanges === 0)).toBe(true);
            expect(flaky.totalCalls("eth_getLogs") + steady.totalCalls("eth_getLogs")).toBe(0);
          } finally {
            await Promise.all([flaky.stop(), steady.stop(), lagging.stop()]);
            await sql.end();
            await db.drop();
          }
        },
      ),
      { numRuns: 12 },
    );
  }, 300_000);

  it("resumes after an abort without gaps or duplicates", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      const store = new SyncStore(sql);
      await store.migrate();
      const pool = new RpcPool({ chainId: CHAIN_ID, endpoints: [anvil.rpcUrl] });
      const filter = normalizeLogFilter({ chainId: CHAIN_ID, topics: [SIMPLE] });
      const sources = [{ filter, startBlock: 0 }];

      const controller = new AbortController();
      let ranges = 0;
      await expect(
        new HistoricalSync({
          pool,
          store,
          sources,
          maxLogRange: 7,
          signal: controller.signal,
          onProgress: () => {
            if (++ranges === 5) controller.abort();
          },
        }).run(finalized),
      ).rejects.toThrow();
      const partial = await store.cachedIntervals(CHAIN_ID, logFilterHash(filter));
      expect(partial).toEqual([[0, 34]]);

      const resumed = await new HistoricalSync({ pool, store, sources, maxLogRange: 1_000 }).run(finalized);
      expect(resumed.filters[0]?.fetchedBlocks).toBe(finalized - 34);
      expect(await store.cachedIntervals(CHAIN_ID, logFilterHash(filter))).toEqual([[0, finalized]]);
      const stored = await store.readLogs(filter, 0, finalized);
      expect(stored.map((l) => [l.blockNumber, l.logIndex])).toEqual(
        (await truth(filter, 0, finalized)).map((l) => [l.blockNumber, l.logIndex]),
      );
      expect(stored.every((l) => l.blockTimestamp > 0)).toBe(true);
    } finally {
      await sql.end();
      await db.drop();
    }
  });

  it("stops cleanly, marking the run incomplete, when every node is behind the target", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    const lagging = await startRpcProxy({ target: anvil.rpcUrl, faults: { lagBlocks: 200 } });
    try {
      const store = new SyncStore(sql);
      await store.migrate();
      const pool = new RpcPool({
        chainId: CHAIN_ID,
        endpoints: [lagging.url],
        sleep: () => Promise.resolve(),
      });
      const filter = normalizeLogFilter({ chainId: CHAIN_ID, topics: [SIMPLE] });
      const report = await new HistoricalSync({ pool, store, sources: [{ filter, startBlock: 0 }] }).run(
        finalized,
      );
      expect(report.incomplete).toBe(true);
      expect(await store.cachedIntervals(CHAIN_ID, logFilterHash(filter))).toEqual([]);
    } finally {
      await lagging.stop();
      await sql.end();
      await db.drop();
    }
  });

  it("refuses a header whose hash differs from the cached finalised block", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      const store = new SyncStore(sql);
      await store.migrate();
      const filter = normalizeLogFilter({ chainId: CHAIN_ID });
      const header = (hash: Hex): RpcBlockHeader => ({
        number: 5,
        hash,
        parentHash: `0x${"00".repeat(32)}`,
        timestamp: 1,
        logsBloom: `0x${"00".repeat(256)}`,
      });
      const commit = (hash: Hex, from: number) =>
        store.commitRange({
          filter,
          filterHash: logFilterHash(filter),
          fromBlock: from,
          toBlock: from,
          logs: [],
          headers: [header(hash)],
        });
      await commit(`0x${"11".repeat(32)}`, 5);
      await commit(`0x${"11".repeat(32)}`, 6); // same hash again: fine
      await expect(commit(`0x${"22".repeat(32)}`, 7)).rejects.toThrow(/different hash/);
      // The refused range was not marked cached.
      expect(await store.cachedIntervals(CHAIN_ID, logFilterHash(filter))).toEqual([[5, 6]]);
    } finally {
      await sql.end();
      await db.drop();
    }
  });
});
