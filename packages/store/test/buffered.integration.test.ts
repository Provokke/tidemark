import { connect } from "@tidemark/pg";
import { type AnyTable, type Row, fromDbRow, onchainTable, primaryKey, t, tableDdl } from "@tidemark/schema";
import { createTestDatabase } from "@tidemark/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BufferedStore, Db, RecordNotFoundError, UniqueConstraintError } from "../src/index.js";

const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  label: t.text(),
});
const allowance = onchainTable(
  "allowance",
  { owner: t.hex().notNull(), spender: t.hex().notNull(), amount: t.bigint().notNull() },
  (a) => ({ pk: primaryKey({ columns: [a.owner, a.spender] }) }),
);
const tables: AnyTable[] = [account, allowance];

// Few keys, so operations collide often.
const addr = fc.constantFrom("0x01", "0x02", "0x03", "0x04", "0xAA");
const canon = (h: string) => h.toLowerCase();
const amount = fc.bigInt({ min: 0n, max: 10n ** 30n });

type Op =
  | { op: "insert"; id: string; balance: bigint; label: string | null }
  | { op: "upsert"; id: string; balance: bigint }
  | { op: "nothing"; id: string; balance: bigint }
  | { op: "add"; id: string; delta: bigint }
  | { op: "delete"; id: string }
  | { op: "find"; id: string }
  | { op: "allow"; owner: string; spender: string; amount: bigint }
  | { op: "disallow"; owner: string; spender: string }
  | { op: "flush" }
  | { op: "failedFlush" }
  | { op: "reopen" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("insert" as const),
    id: addr,
    balance: amount,
    label: fc.option(fc.string(), { nil: null }),
  }),
  fc.record({ op: fc.constant("upsert" as const), id: addr, balance: amount }),
  fc.record({ op: fc.constant("nothing" as const), id: addr, balance: amount }),
  fc.record({ op: fc.constant("add" as const), id: addr, delta: amount }),
  fc.record({ op: fc.constant("delete" as const), id: addr }),
  fc.record({ op: fc.constant("find" as const), id: addr }),
  fc.record({ op: fc.constant("allow" as const), owner: addr, spender: addr, amount }),
  fc.record({ op: fc.constant("disallow" as const), owner: addr, spender: addr }),
  fc.constant({ op: "flush" as const }),
  fc.constant({ op: "failedFlush" as const }),
  fc.constant({ op: "reopen" as const }),
);

async function dbContents(sql: ReturnType<typeof connect>) {
  const accounts = (await sql.unsafe('select * from "app"."account" order by id')).map((r) =>
    fromDbRow(account, r),
  );
  const allowances = (await sql.unsafe('select * from "app"."allowance" order by owner, spender')).map((r) =>
    fromDbRow(allowance, r),
  );
  return { accounts, allowances };
}

describe("BufferedStore", () => {
  it("behaves like a map of rows through any sequence of writes, flushes, failed flushes and reopens", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url, { max: 4 });
    try {
      await sql.unsafe("create schema app");
      for (const table of tables) for (const ddl of tableDdl(table, "app")) await sql.unsafe(ddl);

      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { maxLength: 60 }), fc.boolean(), async (ops, tinyCache) => {
          await sql.unsafe('truncate "app"."account", "app"."allowance"');
          const open = () =>
            BufferedStore.open({ sql, schema: "app", tables, maxCachedRows: tinyCache ? 2 : 1_000 });
          let store = await open();
          let dbApi = new Db(store);
          const accounts = new Map<string, Row>();
          const allowances = new Map<string, Row>();
          // What the database holds as of the last successful flush.
          let committed = { accounts: new Map(accounts), allowances: new Map(allowances) };

          for (const o of ops) {
            switch (o.op) {
              case "insert": {
                const id = canon(o.id);
                const result = dbApi
                  .insert(account)
                  .values({ id: o.id as `0x${string}`, balance: o.balance, label: o.label });
                if (accounts.has(id)) await expect(result).rejects.toBeInstanceOf(UniqueConstraintError);
                else {
                  await result;
                  accounts.set(id, { id, balance: o.balance, label: o.label });
                }
                break;
              }
              case "upsert": {
                const id = canon(o.id);
                await dbApi
                  .insert(account)
                  .values({ id: o.id as `0x${string}`, balance: o.balance })
                  .onConflictDoUpdate((row) => ({ balance: row.balance + o.balance }));
                const existing = accounts.get(id);
                accounts.set(
                  id,
                  existing === undefined
                    ? { id, balance: o.balance, label: null }
                    : { ...existing, balance: (existing.balance as bigint) + o.balance },
                );
                break;
              }
              case "nothing": {
                const id = canon(o.id);
                await dbApi
                  .insert(account)
                  .values({ id: o.id as `0x${string}`, balance: o.balance })
                  .onConflictDoNothing();
                if (!accounts.has(id)) accounts.set(id, { id, balance: o.balance, label: null });
                break;
              }
              case "add": {
                const id = canon(o.id);
                const result = dbApi
                  .update(account, { id: o.id as `0x${string}` })
                  .set((row) => ({ balance: row.balance + o.delta }));
                const existing = accounts.get(id);
                if (existing === undefined) await expect(result).rejects.toBeInstanceOf(RecordNotFoundError);
                else {
                  const updated = { ...existing, balance: (existing.balance as bigint) + o.delta };
                  expect(await result).toEqual(updated);
                  accounts.set(id, updated);
                }
                break;
              }
              case "delete":
                expect(await dbApi.delete(account, { id: o.id as `0x${string}` })).toBe(
                  accounts.delete(canon(o.id)),
                );
                break;
              case "find":
                expect(await dbApi.find(account, { id: o.id as `0x${string}` })).toEqual(
                  accounts.get(canon(o.id)) ?? null,
                );
                break;
              case "allow": {
                const key = `${canon(o.owner)}|${canon(o.spender)}`;
                await dbApi
                  .insert(allowance)
                  .values({
                    owner: o.owner as `0x${string}`,
                    spender: o.spender as `0x${string}`,
                    amount: o.amount,
                  })
                  .onConflictDoUpdate({ amount: o.amount });
                allowances.set(key, { owner: canon(o.owner), spender: canon(o.spender), amount: o.amount });
                break;
              }
              case "disallow": {
                const key = `${canon(o.owner)}|${canon(o.spender)}`;
                expect(
                  await dbApi.delete(allowance, {
                    owner: o.owner as `0x${string}`,
                    spender: o.spender as `0x${string}`,
                  }),
                ).toBe(allowances.delete(key));
                break;
              }
              case "flush":
                await store.flush();
                committed = { accounts: new Map(accounts), allowances: new Map(allowances) };
                break;
              case "failedFlush": {
                await expect(
                  store.flush(() => Promise.reject(new Error("checkpoint write failed"))),
                ).rejects.toThrow(/checkpoint/);
                // Nothing reached the database; memory still holds every pending change.
                const contents = await dbContents(sql);
                expect(contents.accounts).toEqual(
                  [...committed.accounts.values()].sort((a, b) =>
                    (a.id as string) < (b.id as string) ? -1 : 1,
                  ),
                );
                break;
              }
              case "reopen":
                // A restart after the last flush: unflushed changes are lost, like after a crash.
                store = await open();
                dbApi = new Db(store);
                accounts.clear();
                allowances.clear();
                for (const [k, v] of committed.accounts) accounts.set(k, v);
                for (const [k, v] of committed.allowances) allowances.set(k, v);
                break;
            }
          }

          await store.flush();
          const contents = await dbContents(sql);
          const sortBy = (key: (r: Row) => string) => (a: Row, b: Row) => (key(a) < key(b) ? -1 : 1);
          expect(contents.accounts).toEqual([...accounts.values()].sort(sortBy((r) => r.id as string)));
          expect(contents.allowances).toEqual(
            [...allowances.values()].sort(sortBy((r) => `${r.owner as string}|${r.spender as string}`)),
          );
        }),
        { numRuns: 150 },
      );
    } finally {
      await sql.end();
      await db.drop();
    }
  }, 300_000);

  it("serves misses on an empty table from memory, and reads through when resuming", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      await sql.unsafe("create schema app");
      for (const table of tables) for (const ddl of tableDdl(table, "app")) await sql.unsafe(ddl);
      const fresh = await BufferedStore.open({ sql, schema: "app", tables });
      const freshDb = new Db(fresh);
      for (let i = 0; i < 100; i++) {
        await freshDb
          .insert(account)
          .values({ id: `0x${i.toString(16).padStart(2, "0")}`, balance: BigInt(i) });
      }
      expect(fresh.databaseReads).toBe(0);
      await fresh.flush();

      const resumed = await BufferedStore.open({ sql, schema: "app", tables });
      expect(await new Db(resumed).find(account, { id: "0x05" })).toEqual({
        id: "0x05",
        balance: 5n,
        label: null,
      });
      expect(await new Db(resumed).find(account, { id: "0x05" })).not.toBeNull();
      expect(resumed.databaseReads).toBe(1); // second find was a cache hit
    } finally {
      await sql.end();
      await db.drop();
    }
  });
});
