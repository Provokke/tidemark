import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, t, tableDdl } from "@tidemark/schema";
import { type TestDatabase, createTestDatabase } from "@tidemark/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/index.js";

const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  name: t.text(),
  seen: t.timestamp(),
});
const schema = { account };
const SECRET = "TOPSECRET-7f3a";

let db: TestDatabase;
let sql: Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = connect(db.url, { max: 6 });
  await sql.unsafe("create schema app");
  for (const ddl of tableDdl(account, "app")) await sql.unsafe(ddl);
  await sql.unsafe(
    `insert into app.account select decode(lpad(to_hex(g), 40, '0'), 'hex'), (g::numeric * 10^30), 'acct ' || g, to_timestamp(1700000000 + g) from generate_series(1, 50) g`,
  );
  await sql.unsafe(`create table app."_tm_checkpoints" (chain_id bigint primary key, note text)`);
  await sql.unsafe(`insert into app."_tm_checkpoints" values (1, '${SECRET}')`);
  await sql.unsafe(
    `create schema secret; create table secret.data (v text); insert into secret.data values ('${SECRET}')`,
  );
  await sql.unsafe(`create table public.leak (v text); insert into public.leak values ('${SECRET}')`);
});

afterAll(async () => {
  await sql.end();
  await db.drop();
});

const app = (limits = {}) => createApi({ sql, schema, databaseSchema: "app", limits }).app;

async function run(query: string, params?: unknown[], a = app()) {
  const res = await a.request("/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, params }),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: JSON.parse(text) as {
      columns?: { name: string; type: number }[];
      rows?: unknown[][];
      truncated?: boolean;
      error?: string;
    },
  };
}

async function fingerprint() {
  const [row] = await sql.unsafe<{ h: string }[]>(`select md5(
    (select string_agg(md5(a::text), '' order by id) from app.account a) ||
    (select count(*)::text from secret.data) || (select count(*)::text from public.leak) ||
    (select count(*)::text from app."_tm_checkpoints")) as h`);
  return row?.h;
}

describe("SQL endpoint", () => {
  it("runs reads with joins, CTEs, windows, aggregates and parameters", async () => {
    const r = await run(
      `with ranked as (
         select id, balance, rank() over (order by balance desc) as r from account where name like $1
       )
       select a.id, a.balance, a.name, a.seen, r.r, count(*) over () as n
       from ranked r join app.account a on a.id = r.id
       where r.r <= $2 order by r.r`,
      ["acct 1%", 3],
    );
    expect(r.status).toBe(200);
    expect(r.body.columns?.map((c) => c.name)).toEqual(["id", "balance", "name", "seen", "r", "n"]);
    expect(r.body.rows?.length).toBe(3);
    const [first] = r.body.rows ?? [];
    expect(first?.[0]).toBe(`0x${(19).toString(16).padStart(40, "0")}`);
    expect(first?.[1]).toBe((19n * 10n ** 30n).toString()); // numeric stays exact, as a string
    expect(first?.[3]).toBe(new Date((1_700_000_000 + 19) * 1000).toISOString());
    expect(first?.[5]).toBe("3"); // int8 as a string
  });

  it("caps rows and marks the result truncated", async () => {
    const r = await run("select g from generate_series(1, 5000) g", [], app({ sqlMaxRows: 1000 }));
    expect(r.body.rows?.length).toBe(1000);
    expect(r.body.truncated).toBe(true);
  });

  it("stops queries at the statement timeout", async () => {
    const r = await run(
      "select count(*) from generate_series(1, 1000000000) g",
      [],
      app({ statementTimeoutMs: 200 }),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/statement timeout/);
  });

  it.each([
    ["two statements", "select 1; select 2"],
    ["insert", "insert into account (id, balance) values ('\\x00', 1)"],
    ["update", "update account set balance = 0"],
    ["delete", "delete from account"],
    ["merge", "merge into account a using account b on a.id = b.id when matched then delete"],
    ["data-modifying CTE", "with d as (delete from account returning *) select * from d"],
    ["select into", "select * into account2 from account"],
    ["for update", "select * from account for update"],
    ["for share", "select * from account for key share"],
    ["pg_sleep", "select pg_sleep(10)"],
    ["set_config", "select set_config('statement_timeout', '0', false)"],
    ["current_setting", "select current_setting('data_directory')"],
    ["pg_read_file", "select pg_read_file('/etc/passwd')"],
    ["dblink", "select * from dblink('host=x', 'select 1') as t(a int)"],
    ["advisory lock", "select pg_advisory_lock(1)"],
    ["large object", "select lo_import('/etc/passwd')"],
    ["catalog, qualified", "select * from pg_catalog.pg_class"],
    ["catalog, unqualified", "select relname from pg_class"],
    ["catalog, roles", "select * from pg_authid"],
    ["information_schema", "select * from information_schema.tables"],
    ["another schema", "select * from secret.data"],
    ["public schema", "select * from public.leak"],
    ["unqualified other table", "select * from leak"],
    ["bookkeeping table", 'select * from "_tm_checkpoints"'],
    ["regclass cast", "select 'pg_authid'::regclass"],
    ["tablesample", "select * from account tablesample system (50)"],
    ["copy", "copy account to stdout"],
    ["set", "set statement_timeout = 0"],
    ["do block", "do $$ begin perform 1; end $$"],
    ["explain analyze", "explain analyze delete from account"],
    ["lock", "lock table account"],
    ["schema-qualified function", "select public.anything()"],
    ["cross-database", "select * from otherdb.app.account"],
    ["syntax error", "selec 1"],
    ["empty", ""],
    ["comment only", "-- nothing"],
  ])("refuses %s", async (_, query) => {
    const before = await fingerprint();
    const r = await run(query);
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(SECRET);
    expect(await fingerprint()).toBe(before);
  });

  it("refuses parameters that are not scalars", async () => {
    expect((await run("select $1::text", [{ a: 1 }])).status).toBe(400);
  });

  it("fuzz: any assembled query is refused or harmless; nothing leaks or changes", async () => {
    const before = await fingerprint();
    const target = fc.constantFrom(
      "account",
      "app.account",
      "secret.data",
      "public.leak",
      "leak",
      "pg_class",
      "pg_catalog.pg_authid",
      "information_schema.tables",
      '"_tm_checkpoints"',
      "app._tm_checkpoints",
      "tm_meta.migrations",
      '"ACCOUNT"',
      "account a",
    );
    const expr = fc.constantFrom(
      "1",
      "id",
      "balance",
      "name",
      "count(*)",
      "pg_sleep(0.01)",
      "current_setting('search_path')",
      "version()",
      "set_config('a.b', 'c', true)",
      "'x'::regclass",
      "(select v from secret.data limit 1)",
      "lower(name)",
      "row_number() over ()",
      "now()",
      "$1",
      "pg_read_file('x')",
      "txid_current()",
      "(select 1)",
    );
    const tail = fc.constantFrom(
      "",
      " where id is not null",
      " order by 1",
      " limit 3",
      " for update",
      "; delete from account",
      " union select v from secret.data",
      " union all select relname from pg_class",
      "; select 1",
      " into newtable",
      " -- comment",
      " group by 1",
      "/* */",
      ")",
      "'",
      " returning *",
    );
    const query = fc.oneof(
      fc
        .tuple(fc.array(expr, { minLength: 1, maxLength: 3 }), target, tail)
        .map(([e, f, tl]) => `select ${e.join(", ")} from ${f}${tl}`),
      fc.tuple(target, tail).map(([f, tl]) => `with x as (select * from ${f}) select * from x${tl}`),
      fc.tuple(expr, tail).map(([e, tl]) => `select ${e}${tl}`),
      fc.string({ maxLength: 60 }),
    );
    await fc.assert(
      fc.asyncProperty(
        query,
        fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 2 }),
        async (q, params) => {
          const r = await run(q, params);
          expect([200, 400]).toContain(r.status);
          expect(r.text).not.toContain(SECRET);
        },
      ),
      { numRuns: 400 },
    );
    expect(await fingerprint()).toBe(before);
  }, 180_000);
});
