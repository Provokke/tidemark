/**
 * GraphQL query latency on a 1,000,000-row table.
 *
 * Loads ROWS swaps across 1,000 pools, then times GraphQL requests through the API in-process (no
 * network): a primary-key lookup, an indexed filter with ordering, a keyset page deep in a result,
 * and a nested relation. Prints p50/p95/p99 per query as JSON.
 *
 *   TIDEMARK_TEST_DATABASE_URL=... pnpm --filter @tidemark/bench run api
 */
import { createApi } from "@tidemark/api";
import { connect } from "@tidemark/pg";
import { index, onchainTable, relations, t, tableDdl } from "@tidemark/schema";
import { createTestDatabase } from "@tidemark/testing";

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const RUNS = Number(process.env.RUNS ?? 300);

const pool = onchainTable("pool", { id: t.hex().primaryKey(), fee: t.integer().notNull() });
const swap = onchainTable(
  "swap",
  {
    id: t.text().primaryKey(),
    poolId: t.hex().notNull(),
    amount: t.bigint().notNull(),
    block: t.integer().notNull(),
  },
  (s) => ({ byPoolAmount: index().on(s.poolId, s.amount), byBlock: index().on(s.block) }),
);
const schema = {
  pool,
  swap,
  poolRelations: relations(pool, ({ many }) => ({
    swaps: many(swap, { fields: ["id"], references: ["poolId"] }),
  })),
};

const db = await createTestDatabase();
const sql = connect(db.url, { max: 8 });
try {
  await sql.unsafe("create schema app");
  for (const table of [pool, swap]) for (const ddl of tableDdl(table, "app")) await sql.unsafe(ddl);
  const loading = performance.now();
  await sql.unsafe(
    `insert into app.pool select decode(lpad(to_hex(g), 40, '0'), 'hex'), (g % 3) * 500 from generate_series(0, 999) g`,
  );
  await sql.unsafe(`insert into app.swap
    select 's' || g, decode(lpad(to_hex(g % 1000), 40, '0'), 'hex'), ((g::int8 * 7919) % 1000003)::numeric * 10^18, g / 10
    from generate_series(1, ${ROWS}) g`);
  await sql.unsafe("analyze app.swap; analyze app.pool");
  const loadSeconds = (performance.now() - loading) / 1000;

  const { app } = createApi({ sql, schema, databaseSchema: "app" });
  const gql = async (query: string, variables?: Record<string, unknown>) => {
    const res = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { errors?: unknown; data?: any };
    if (body.errors !== undefined) throw new Error(JSON.stringify(body.errors));
    return body.data;
  };
  const poolId = (i: number) => `0x${(i % 1000).toString(16).padStart(40, "0")}`;

  const deepCursor = (
    await gql(
      `{ swaps(where: { poolId: { eq: "${poolId(7)}" } }, orderBy: [{ amount: DESC }], first: 500) { pageInfo { endCursor } } }`,
    )
  ).swaps.pageInfo.endCursor;

  const cases: [string, (i: number) => Promise<unknown>][] = [
    [
      "primary key",
      (i) =>
        gql(`query($id: String!) { swap(id: $id) { id amount block } }`, {
          id: `s${1 + ((i * 104729) % ROWS)}`,
        }),
    ],
    [
      "indexed filter + order, 20 rows",
      (i) =>
        gql(
          `query($p: Hex!) { swaps(where: { poolId: { eq: $p } }, orderBy: [{ amount: DESC }], first: 20) { nodes { id amount } } }`,
          { p: poolId(i) },
        ),
    ],
    [
      "keyset page 500 rows deep",
      () =>
        gql(
          `query($c: String!) { swaps(where: { poolId: { eq: "${poolId(7)}" } }, orderBy: [{ amount: DESC }], first: 20, after: $c) { nodes { id } } }`,
          { c: deepCursor },
        ),
    ],
    [
      "range filter on block, 50 rows",
      (i) =>
        gql(
          `query($b: Int!) { swaps(where: { block: { gte: $b } }, orderBy: [{ block: ASC }], first: 50) { nodes { id block } } }`,
          { b: (i * 331) % (ROWS / 10) },
        ),
    ],
    [
      "10 pools with 5 swaps each (nested)",
      (i) =>
        gql(
          `query($p: [Hex!]) { pools(where: { id: { in: $p } }) { nodes { id swaps(first: 5, orderBy: [{ amount: DESC }]) { nodes { id amount } } } } }`,
          { p: Array.from({ length: 10 }, (_, k) => poolId(i * 10 + k)) },
        ),
    ],
  ];

  const results: Record<string, { p50: number; p95: number; p99: number }> = {};
  for (const [name, run] of cases) {
    for (let i = 0; i < 20; i++) await run(i); // warm up
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      await run(i);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) =>
      Number((times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0).toFixed(2));
    results[name] = { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  }
  console.log(
    JSON.stringify(
      {
        benchmark: "graphql-latency-ms",
        rows: ROWS,
        runs: RUNS,
        loadSeconds: Number(loadSeconds.toFixed(1)),
        results,
      },
      null,
      1,
    ),
  );
} finally {
  await sql.end();
  await db.drop();
}
