import { type LogFilterInput, logFilterHash, normalizeLogFilter } from "@tidemark/core";
import { connect } from "@tidemark/pg";
import { RpcPool } from "@tidemark/rpc";
import { type Cassette, createTestDatabase, startRpcProxy } from "@tidemark/testing";
import { HistoricalSync, SyncStore } from "../src/index.js";

/**
 * A recorded historical sync: the sources, the target block, every JSON-RPC answer the sync
 * needed, and what it cached. Replaying the cassette must reproduce `expected` exactly, with no
 * node behind it.
 */
export interface SyncFixture {
  readonly description: string;
  readonly chainId: number;
  readonly target: number;
  readonly maxLogRange: number;
  readonly sources: readonly { filter: LogFilterInput; startBlock: number; endBlock?: number }[];
  readonly expected: readonly { filterHash: string; logs: [number, number, string][] }[];
  readonly cassette: Cassette;
}

export async function syncAndCollect(
  rpcUrl: string,
  fixture: Omit<SyncFixture, "expected" | "cassette" | "description">,
) {
  const db = await createTestDatabase();
  const sql = connect(db.url, { max: 4 });
  try {
    const store = new SyncStore(sql);
    await store.migrate();
    const sources = fixture.sources.map((s) => ({ ...s, filter: normalizeLogFilter(s.filter) }));
    const pool = new RpcPool({
      chainId: fixture.chainId,
      endpoints: [rpcUrl],
      rounds: 1,
      sleep: () => Promise.resolve(),
    });
    // One filter at a time, so the order of requests (and so the cassette) is deterministic.
    const report = await new HistoricalSync({
      pool,
      store,
      sources,
      maxLogRange: fixture.maxLogRange,
      concurrency: 1,
    }).run(fixture.target);
    if (report.incomplete) throw new Error("sync did not reach the target");
    const expected = [];
    for (const source of sources) {
      const logs = await store.readLogs(
        source.filter,
        source.startBlock,
        Math.min(source.endBlock ?? fixture.target, fixture.target),
      );
      expected.push({
        filterHash: logFilterHash(source.filter),
        logs: logs.map((l): [number, number, string] => [l.blockNumber, l.logIndex, l.transactionHash]),
      });
    }
    return expected;
  } finally {
    await sql.end();
    await db.drop();
  }
}

export async function recordFixture(
  rpcUrl: string,
  fixture: Omit<SyncFixture, "expected" | "cassette">,
): Promise<SyncFixture> {
  const proxy = await startRpcProxy({ target: rpcUrl, record: true });
  try {
    const expected = await syncAndCollect(proxy.url, fixture);
    return { ...fixture, expected, cassette: proxy.cassette };
  } finally {
    await proxy.stop();
  }
}
