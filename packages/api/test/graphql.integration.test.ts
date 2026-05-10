import { createHash } from "node:crypto";
import { type Sql, connect, postgres } from "@tidemark/pg";
import { index, onchainTable, relations, t, tableDdl } from "@tidemark/schema";
import { createTestDatabase, type TestDatabase } from "@tidemark/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.js";

const pool = onchainTable(
  "pool",
  {
    id: t.hex().primaryKey(),
    token0: t.hex().notNull(),
    fee: t.integer().notNull(),
    liquidity: t.bigint().notNull(),
    label: t.text(),
    createdAt: t.timestamp().notNull(),
  },
  (p) => ({ byFee: index().on(p.fee) }),
);
const swap = onchainTable("swap", {
  id: t.text().primaryKey(),
  poolId: t.hex().notNull(),
  amount: t.bigint().notNull(),
  // Nullable on purpose: ordering and paging must handle nulls.
  note: t.text(),
  block: t.integer().notNull(),
});
const poolRelations = relations(pool, ({ many }) => ({
  swaps: many(swap, { fields: ["id"], references: ["poolId"] }),
}));
const swapRelations = relations(swap, ({ one }) => ({
  pool: one(pool, { fields: ["poolId"], references: ["id"] }),
}));
const schema = { pool, swap, poolRelations, swapRelations };

let db: TestDatabase;
let sql: Sql;
const POOLS = 6;
const pools: {
  id: string;
  token0: string;
  fee: number;
  liquidity: bigint;
  label: string | null;
  createdAt: Date;
}[] = [];
const swaps: { id: string; poolId: string; amount: bigint; note: string | null; block: number }[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  sql = connect(db.url, { max: 8 });
  await sql.unsafe("create schema app");
  for (const table of [pool, swap]) for (const ddl of tableDdl(table, "app")) await sql.unsafe(ddl);
  await sql.unsafe(`create table app."_tm_checkpoints" (chain_id bigint primary key, block_number bigint not null,
    checkpoint text not null, finalized_block bigint not null, finalized_checkpoint text not null, updated_at timestamptz not null default now())`);
  await sql.unsafe(
    `insert into app."_tm_checkpoints" values (8453, 100, '${"1".repeat(75)}', 90, '${"0".repeat(75)}', now())`,
  );

  for (let i = 0; i < POOLS; i++) {
    pools.push({
      id: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      token0: `0x${(i % 2).toString(16).padStart(40, "a")}`,
      fee: [500, 3000, 10000][i % 3] as number,
      liquidity: 10n ** BigInt(20 + i * 7), // past 2^64 for most
      label: i % 3 === 0 ? null : `pool ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
    });
  }
  const sample = fc.sample(
    fc.tuple(
      fc.nat(POOLS - 1),
      fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
      fc.option(fc.constantFrom("a", "b", "c"), { nil: null }),
      fc.nat(50),
    ),
    { numRuns: 120, seed: 11 },
  );
  sample.forEach(([p, amount, note, block], i) =>
    swaps.push({
      id: `s${i.toString().padStart(3, "0")}`,
      poolId: pools[p]?.id as string,
      amount,
      note,
      block,
    }),
  );

  for (const p of pools) {
    await sql`insert into app.pool values (${Buffer.from(p.id.slice(2), "hex")}, ${Buffer.from(p.token0.slice(2), "hex")}, ${p.fee}, ${p.liquidity.toString()}, ${p.label}, ${p.createdAt})`;
  }
  for (const s of swaps) {
    await sql`insert into app.swap values (${s.id}, ${Buffer.from(s.poolId.slice(2), "hex")}, ${s.amount.toString()}, ${s.note}, ${s.block})`;
  }
});

afterAll(async () => {
  await sql.end();
  await db.drop();
});

function api(extra: Partial<Parameters<typeof createApi>[0]> = {}) {
  return createApi({ sql, schema, databaseSchema: "app", ...extra }).app;
}

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  app = api(),
  headers: Record<string, string> = {},
) {
  const res = await app.request("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, body: (await res.json()) as { data?: any; errors?: { message: string }[] } };
}

describe("GraphQL API", () => {
  it("fetches by primary key, case-insensitively, with big integers as strings", async () => {
    const p = pools[1];
    const { body } = await gql(`query($id: Hex!) { pool(id: $id) { id fee liquidity label createdAt } }`, {
      id: p?.id.toUpperCase().replace("0X", "0x"),
    });
    expect(body.data.pool).toEqual({
      id: p?.id,
      fee: p?.fee,
      liquidity: p?.liquidity.toString(),
      label: p?.label,
      createdAt: p?.createdAt.toISOString(),
    });
    const missing = await gql(`{ pool(id: "0x00") { id } }`);
    expect(missing.body.data.pool).toBeNull();
  });

  it("filters with every operator, combinators and relation filters", async () => {
    const ids = async (where: string) =>
      (
        (await gql(`{ swaps(where: ${where}, first: 1000) { nodes { id } } }`)).body.data?.swaps.nodes as {
          id: string;
        }[]
      )
        .map((n) => n.id)
        .sort();
    const expected = (pred: (s: (typeof swaps)[number]) => boolean) =>
      swaps
        .filter(pred)
        .map((s) => s.id)
        .sort();
    const pool0 = pools[0]?.id as string;
    expect(await ids(`{ amount: { gt: "0" } }`)).toEqual(expected((s) => s.amount > 0n));
    expect(await ids(`{ amount: { lte: "-5", gte: "-1000000000000000000000000000000" } }`)).toEqual(
      expected((s) => s.amount <= -5n),
    );
    expect(await ids(`{ block: { in: [1, 2, 3] } }`)).toEqual(expected((s) => [1, 2, 3].includes(s.block)));
    expect(await ids(`{ block: { notIn: [1, 2, 3] } }`)).toEqual(
      expected((s) => ![1, 2, 3].includes(s.block)),
    );
    expect(await ids(`{ note: { isNull: true } }`)).toEqual(expected((s) => s.note === null));
    expect(await ids(`{ note: { ne: "a" } }`)).toEqual(expected((s) => s.note !== "a"));
    expect(await ids(`{ id: { startsWith: "s01" } }`)).toEqual(expected((s) => s.id.startsWith("s01")));
    expect(await ids(`{ id: { contains: "9" } }`)).toEqual(expected((s) => s.id.includes("9")));
    expect(await ids(`{ id: { endsWith: "7" } }`)).toEqual(expected((s) => s.id.endsWith("7")));
    expect(await ids(`{ poolId: { eq: "${pool0}" } }`)).toEqual(expected((s) => s.poolId === pool0));
    expect(await ids(`{ OR: [{ block: { lt: 5 } }, { note: { eq: "c" } }] }`)).toEqual(
      expected((s) => s.block < 5 || s.note === "c"),
    );
    expect(await ids(`{ NOT: { block: { lt: 25 } }, AND: [{ note: { isNull: false } }] }`)).toEqual(
      expected((s) => s.block >= 25 && s.note !== null),
    );
    // Relation filters.
    const feeOf = (id: string) => pools.find((p) => p.id === id)?.fee;
    expect(await ids(`{ pool: { fee: { eq: 3000 } } }`)).toEqual(expected((s) => feeOf(s.poolId) === 3000));
    const poolIds = async (where: string) =>
      ((await gql(`{ pools(where: ${where}) { nodes { id } } }`)).body.data?.pools.nodes as { id: string }[])
        .map((n) => n.id)
        .sort();
    const poolsWhere = (pred: (p: (typeof pools)[number]) => boolean) =>
      pools
        .filter(pred)
        .map((p) => p.id)
        .sort();
    const swapsOf = (p: string) => swaps.filter((s) => s.poolId === p);
    expect(await poolIds(`{ swaps: { some: { note: { eq: "a" } } } }`)).toEqual(
      poolsWhere((p) => swapsOf(p.id).some((s) => s.note === "a")),
    );
    expect(await poolIds(`{ swaps: { none: { amount: { gt: "0" } } } }`)).toEqual(
      poolsWhere((p) => !swapsOf(p.id).some((s) => s.amount > 0n)),
    );
    expect(await poolIds(`{ swaps: { every: { block: { lt: 45 } } } }`)).toEqual(
      poolsWhere((p) => swapsOf(p.id).every((s) => s.block < 45)),
    );
  });

  it("pages forward and backward through any ordering, nulls included, matching a JS sort", async () => {
    const columns = ["note", "block", "amount", "poolId"] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...columns), { minLength: 0, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        fc.integer({ min: 1, max: 40 }),
        async (cols, descs, size) => {
          const orderBy = cols.map((c, i) => `{ ${c}: ${descs[i] === true ? "DESC" : "ASC"} }`).join(", ");
          // Postgres semantics: nulls last ascending, first descending; then the primary key.
          const cmp = (a: (typeof swaps)[number], b: (typeof swaps)[number]) => {
            for (const [i, c] of cols.entries()) {
              const desc = descs[i] === true;
              const x = a[c];
              const y = b[c];
              if (x === y) continue;
              if (x === null) return desc ? -1 : 1;
              if (y === null) return desc ? 1 : -1;
              const r = x < y ? -1 : 1;
              return desc ? -r : r;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          };
          const expected = [...swaps].sort(cmp).map((s) => s.id);

          const forward: string[] = [];
          let after: string | null = null;
          for (let page = 0; page < 200; page++) {
            const { body } = await gql(
              `query($after: String) { swaps(orderBy: [${orderBy}], first: ${size}, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }`,
              { after },
            );
            const conn = body.data.swaps;
            forward.push(...conn.nodes.map((n: { id: string }) => n.id));
            if (!conn.pageInfo.hasNextPage) break;
            after = conn.pageInfo.endCursor;
          }
          expect(forward).toEqual(expected);

          const backward: string[] = [];
          let before: string | null = null;
          for (let page = 0; page < 200; page++) {
            const { body } = await gql(
              `query($before: String) { swaps(orderBy: [${orderBy}], last: ${size}, before: $before) { nodes { id } pageInfo { hasPreviousPage startCursor } } }`,
              { before },
            );
            const conn = body.data.swaps;
            backward.unshift(...conn.nodes.map((n: { id: string }) => n.id));
            if (!conn.pageInfo.hasPreviousPage) break;
            before = conn.pageInfo.startCursor;
          }
          expect(backward).toEqual(expected);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);

  it("resolves nested relations per parent, batched, with totals", async () => {
    const statements: string[] = [];
    const logged = postgres(db.url, { max: 2, debug: (_connection, query) => statements.push(query) });
    const { body } = await gql(
      `{
      pools(orderBy: [{ id: ASC }]) {
        totalCount
        nodes { id swaps(first: 3, orderBy: [{ amount: DESC }], where: { block: { gte: 10 } }) { totalCount nodes { id amount pool { id fee } } } }
      }
    }`,
      undefined,
      createApi({ sql: logged, schema, databaseSchema: "app" }).app,
    );
    await logged.end();
    // One query for every pool's swaps and one for every swap's pool, not one per parent.
    expect(statements.filter((q) => q.includes("cross join lateral")).length).toBe(1);
    expect(statements.filter((q) => q.includes('from "app"."pool" t where (t."id") in')).length).toBe(1);
    expect(statements.filter((q) => q.includes('count(*)::int8 as "_tm_n"')).length).toBe(1);
    expect(statements.filter((q) => q.includes('from "app"."swap"')).length).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(body.data.pools.totalCount).toBe(POOLS);
    for (const p of body.data.pools.nodes as {
      id: string;
      swaps: { totalCount: number; nodes: { id: string; amount: string; pool: { id: string } }[] };
    }[]) {
      const mine = swaps
        .filter((s) => s.poolId === p.id && s.block >= 10)
        .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.id < b.id ? -1 : 1));
      expect(p.swaps.totalCount).toBe(mine.length);
      expect(p.swaps.nodes.map((n) => n.id)).toEqual(mine.slice(0, 3).map((s) => s.id));
      expect(p.swaps.nodes.every((n) => n.pool.id === p.id)).toBe(true);
    }
  });

  it("reports chain status in _meta", async () => {
    const { body } = await gql(`{ _meta { chains { chainId blockNumber finalizedBlock checkpoint } } }`);
    expect(body.data._meta.chains).toEqual([
      { chainId: 8453, blockNumber: "100", finalizedBlock: "90", checkpoint: "1".repeat(75) },
    ]);
  });

  it("enforces depth, cost and page-size limits", async () => {
    const deep = await gql(
      `{ swaps { nodes { pool { swaps { nodes { pool { swaps { nodes { pool { id } } } } } } } } } }`,
      undefined,
      api({ limits: { maxDepth: 6 } }),
    );
    expect(deep.status).toBe(400);
    expect(deep.body.errors?.[0]?.message).toMatch(/deeper/);
    const costly = await gql(
      `{ pools(first: 1000) { nodes { swaps(first: 1000) { nodes { id } } } } }`,
      undefined,
      api({ limits: { maxCost: 50_000 } }),
    );
    expect(costly.status).toBe(400);
    expect(costly.body.errors?.[0]?.message).toMatch(/expensive/);
    const big = await gql(`{ swaps(first: 5000) { nodes { id } } }`);
    expect(big.body.errors?.[0]?.message).toMatch(/page size/);
    const both = await gql(`{ swaps(first: 1, last: 1) { nodes { id } } }`);
    expect(both.body.errors?.[0]?.message).toMatch(/either first or last/);
    const badCursor = await gql(`{ swaps(after: "nope") { nodes { id } } }`);
    expect(badCursor.body.errors?.[0]?.message).toMatch(/cursor/);
  });

  it("turns introspection off on request", async () => {
    const open = await gql(`{ __schema { queryType { name } } }`);
    expect(open.body.data.__schema.queryType.name).toBe("Query");
    const closed = await gql(`{ __schema { queryType { name } } }`, undefined, api({ introspection: false }));
    expect(closed.status).toBe(400);
  });

  it("requires an API key when keys are configured, and rate-limits per key", async () => {
    const key = "tm_test_key_123";
    const app = api({
      apiKeyHashes: [createHash("sha256").update(key).digest("hex")],
      limits: { requestsPerSecond: 2 },
    });
    expect((await gql(`{ _meta { chains { chainId } } }`, undefined, app)).status).toBe(401);
    expect(
      (await gql(`{ _meta { chains { chainId } } }`, undefined, app, { authorization: "Bearer wrong" }))
        .status,
    ).toBe(401);
    const statuses = [];
    for (let i = 0; i < 4; i++)
      statuses.push(
        (await gql(`{ _meta { chains { chainId } } }`, undefined, app, { authorization: `Bearer ${key}` }))
          .status,
      );
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses).toContain(429);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("serves status and the SDL", async () => {
    const status = (await (await api().request("/status")).json()) as {
      chains: { chainId: number; blockNumber: string }[];
    };
    expect(status.chains[0]).toMatchObject({ chainId: 8453, blockNumber: "100", finalizedBlock: "90" });
    const sdl = await (await api().request("/graphql/schema")).text();
    expect(sdl).toContain("type Pool");
    expect(sdl).toContain(
      "swaps(where: SwapFilter, orderBy: [SwapOrderBy!], first: Int, after: String, last: Int, before: String): SwapConnection!",
    );
  });
});
