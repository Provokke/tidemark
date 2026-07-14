import { createHash } from "node:crypto";
import { serveApi } from "@tidemark/api";
import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, t, tableDdl } from "@tidemark/schema";
import { type TestDatabase, createTestDatabase } from "@tidemark/testing";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { TidemarkClientError, createClient } from "../src/index.js";

const swap = onchainTable("swap", {
  id: t.text().primaryKey(),
  poolAddress: t.hex().notNull(),
  amount0: t.bigint().notNull(),
  createdAt: t.timestamp().notNull(),
  memo: t.text(),
});
const schema = { swap };
const KEY = "client-test-key";

let db: TestDatabase;
let sql: Sql;
let server: Awaited<ReturnType<typeof serveApi>>;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = connect(db.url);
  await sql.unsafe("create schema app");
  for (const ddl of tableDdl(swap, "app")) await sql.unsafe(ddl);
  await sql.unsafe(
    `insert into app.swap select 's' || g, decode(lpad(to_hex(g % 3), 40, '0'), 'hex'), (g::numeric * 10^25), to_timestamp(1700000000 + g), case when g % 2 = 0 then 'even' end from generate_series(1, 30) g`,
  );
  server = await serveApi({
    sql,
    schema,
    databaseSchema: "app",
    port: 0,
    apiKeyHashes: [createHash("sha256").update(KEY).digest("hex")],
  });
});

afterAll(async () => {
  await server.close();
  await sql.end();
  await db.drop();
});

describe("typed client", () => {
  it("builds typed queries, sends hex as bytes and bigints as decimals, and decodes results", async () => {
    const client = createClient({ url: server.url, apiKey: KEY }, schema);
    const rows = await client.db
      .selectFrom("swap")
      .selectAll()
      .where("poolAddress", "=", "0x0000000000000000000000000000000000000001")
      .where("amount0", ">", 10n ** 26n)
      .orderBy("amount0", "desc")
      .limit(3)
      .execute();
    expectTypeOf(rows[0]?.amount0).toEqualTypeOf<bigint | undefined>();
    expect(rows.map((r) => r.id)).toEqual(["s28", "s25", "s22"]);
    expect(rows[0]).toEqual({
      id: "s28",
      poolAddress: "0x0000000000000000000000000000000000000001",
      amount0: 28n * 10n ** 25n,
      createdAt: new Date((1_700_000_000 + 28) * 1000),
      memo: "even",
    });

    const counted = await client.db
      .selectFrom("swap")
      .select((eb) => eb.fn.countAll<bigint>().as("n"))
      .where("memo", "is", null)
      .executeTakeFirstOrThrow();
    expect(counted.n).toBe(15n);
  });

  it("runs raw SQL and GraphQL, and reports status", async () => {
    const client = createClient({ url: server.url, apiKey: KEY }, schema);
    const raw = await client.sql("select sum(amount0) as total from swap where id = any($1::text[])", [
      "{s1,s2}",
    ]);
    expect(raw.rows[0]?.total).toBe(3n * 10n ** 25n);
    const data = await client.graphql<{ swap: { amount0: string } }>(`{ swap(id: "s7") { amount0 } }`);
    expect(data.swap.amount0).toBe((7n * 10n ** 25n).toString());
    await sql.unsafe(`create table if not exists app."_tm_checkpoints" (chain_id bigint primary key, block_number bigint not null,
      checkpoint text not null, finalized_block bigint not null, finalized_checkpoint text not null, updated_at timestamptz not null default now())`);
    expect(await client.status()).toMatchObject({ schema: "app", chains: [] });
  });

  it("follows live queries over SSE and long-poll, from builders, SQL and GraphQL", async () => {
    const client = createClient({ url: server.url, apiKey: KEY }, schema);
    const commit = async (statement: string) => {
      await sql.begin(async (tx) => {
        await tx.unsafe(statement);
        await tx.unsafe(`select pg_notify('tm_commit', '{"schema":"app","tables":["swap"]}')`);
      });
    };
    const seen: { builder: unknown[][]; sql: unknown[][]; graphql: unknown[]; poll: unknown[][] } = {
      builder: [],
      sql: [],
      graphql: [],
      poll: [],
    };
    const stops = [
      client.live(
        client.db.selectFrom("swap").select(["id", "amount0"]).where("memo", "=", "live").orderBy("id"),
        (rows: { id: string; amount0: bigint }[]) => seen.builder.push(rows),
      ),
      client.live(
        { sql: "select count(*) as n from swap where memo = $1", params: ["live"] },
        (rows: unknown[]) => seen.sql.push(rows),
      ),
      client.live({ graphql: '{ swaps(where: { memo: { eq: "live" } }) { totalCount } }' }, (data) =>
        seen.graphql.push(data),
      ),
      client.live(
        { sql: "select id from swap where memo = 'live'" },
        (rows: unknown[]) => seen.poll.push(rows),
        { transport: "poll" },
      ),
    ];
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!check()) {
        if (Date.now() > deadline)
          throw new Error(
            `timed out: ${JSON.stringify(seen, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v))}`,
          );
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      await until(
        () =>
          seen.builder.length === 1 &&
          seen.sql.length === 1 &&
          seen.graphql.length === 1 &&
          seen.poll.length === 1,
      );
      expect(seen.builder[0]).toEqual([]);
      await commit(
        "insert into app.swap values ('live1', decode(repeat('00', 20), 'hex'), 12345678901234567890123, now(), 'live')",
      );
      await until(
        () =>
          seen.builder.length === 2 &&
          seen.sql.length === 2 &&
          seen.graphql.length === 2 &&
          seen.poll.length === 2,
      );
      expect(seen.builder[1]).toEqual([{ id: "live1", amount0: 12345678901234567890123n }]);
      expect(seen.sql[1]).toEqual([{ n: 1n }]);
      expect(seen.graphql[1]).toEqual({ swaps: { totalCount: 1 } });
      expect(seen.poll[1]).toEqual([{ id: "live1" }]);
    } finally {
      for (const stop of stops) stop();
    }

    // An invalid query reaches onError, not onData.
    const errors: Error[] = [];
    const stop = client.live({ sql: "delete from swap" }, () => undefined, {
      onError: (e) => errors.push(e),
    });
    await until(() => errors.length > 0);
    stop();
    expect(errors[0]).toBeInstanceOf(TidemarkClientError);
  });

  it("surfaces API errors with their status", async () => {
    const anonymous = createClient({ url: server.url }, schema);
    await expect(anonymous.sql("select 1")).rejects.toMatchObject({ status: 401 });
    const client = createClient({ url: server.url, apiKey: KEY }, schema);
    const error = await client.sql("delete from swap").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TidemarkClientError);
    expect((error as TidemarkClientError).status).toBe(400);
    await expect(client.db.transaction().execute(() => Promise.resolve(undefined))).rejects.toThrow(
      /read-only/,
    );
  });
});
