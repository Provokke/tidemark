import { connect } from "@tidemark/pg";
import { type AnyTable, fromDbRow, onchainTable, primaryKey, t, tableDdl } from "@tidemark/schema";
import { createTestDatabase } from "@tidemark/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BufferedStore, Db, enableJournal, journalDdl, pruneJournal, rollbackJournal } from "../src/index.js";

const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  note: t.text(),
  seen: t.timestamp(),
  data: t.json(),
});
const pairs = onchainTable(
  "pairs",
  { a: t.integer().notNull(), b: t.text().notNull(), weight: t.real() },
  (p) => ({ pk: primaryKey({ columns: [p.a, p.b] }) }),
);
const tables: AnyTable[] = [account, pairs];
const CHAIN = 7;

const id = fc.constantFrom("0x01", "0x02", "0x03", "0x04");
type Write =
  | { kind: "upsert"; id: string; balance: bigint; note: string | null }
  | { kind: "delete"; id: string }
  | { kind: "pair"; a: number; b: string; weight: number | null }
  | { kind: "unpair"; a: number; b: string };
const writeArb: fc.Arbitrary<Write> = fc.oneof(
  fc.record({
    kind: fc.constant("upsert" as const),
    id,
    balance: fc.bigInt({ min: -(10n ** 70n), max: 10n ** 70n }),
    note: fc.option(fc.string(), { nil: null }),
  }),
  fc.record({ kind: fc.constant("delete" as const), id }),
  fc.record({
    kind: fc.constant("pair" as const),
    a: fc.integer({ min: 0, max: 3 }),
    b: fc.constantFrom("x", "y"),
    weight: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null }),
  }),
  fc.record({
    kind: fc.constant("unpair" as const),
    a: fc.integer({ min: 0, max: 3 }),
    b: fc.constantFrom("x", "y"),
  }),
);
type Step =
  | { kind: "block"; writes: Write[] }
  | { kind: "rollback"; back: number }
  | { kind: "finalize"; back: number };
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("block" as const),
      writes: fc.array(writeArb, { maxLength: 6 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("rollback" as const), back: fc.integer({ min: 0, max: 6 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("finalize" as const), back: fc.integer({ min: 0, max: 6 }) }),
  },
);

describe("reorg journal", () => {
  it("rolling back to any unfinalised block restores exactly the state at that block", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url, { max: 4 });
    try {
      await sql.unsafe("create schema app");
      for (const table of tables) for (const ddl of tableDdl(table, "app")) await sql.unsafe(ddl);
      for (const ddl of journalDdl("app", tables)) await sql.unsafe(ddl);

      const dump = async () => ({
        account: (await sql.unsafe('select * from "app"."account" order by id')).map((r) =>
          fromDbRow(account, r),
        ),
        pairs: (await sql.unsafe('select * from "app"."pairs" order by a, b')).map((r) =>
          fromDbRow(pairs, r),
        ),
      });

      await fc.assert(
        fc.asyncProperty(
          fc.array(stepArb, { maxLength: 30 }),
          fc.boolean(),
          async (steps, historicalPrefix) => {
            await sql.unsafe(
              'truncate "app"."account", "app"."pairs", "app"."_tm_journal_account", "app"."_tm_journal_pairs"',
            );
            let store = await BufferedStore.open({ sql, schema: "app", tables });
            let block = 100;
            let finalized = 100;
            if (historicalPrefix) {
              // Rows written below the finalised block, without journaling, must survive any rollback.
              await new Db(store).insert(account).values({ id: "0x01", balance: 1n, note: "historical" });
              await store.flush();
            }
            const snapshots = new Map<number, Awaited<ReturnType<typeof dump>>>([[block, await dump()]]);

            for (const step of steps) {
              if (step.kind === "block") {
                block++;
                const api = new Db(store);
                for (const w of step.writes) {
                  if (w.kind === "upsert") {
                    await api
                      .insert(account)
                      .values({
                        id: w.id as `0x${string}`,
                        balance: w.balance,
                        note: w.note,
                        seen: BigInt(block),
                        data: { block },
                      })
                      .onConflictDoUpdate({
                        balance: w.balance,
                        note: w.note,
                        seen: BigInt(block),
                        data: { block },
                      });
                  } else if (w.kind === "delete") {
                    await api.delete(account, { id: w.id as `0x${string}` });
                  } else if (w.kind === "pair") {
                    await api
                      .insert(pairs)
                      .values({ a: w.a, b: w.b, weight: w.weight })
                      .onConflictDoUpdate({ weight: w.weight });
                  } else {
                    await api.delete(pairs, { a: w.a, b: w.b });
                  }
                }
                const b = block;
                await store.flush(undefined, (tx) => enableJournal(tx, CHAIN, b));
                snapshots.set(block, await dump());
              } else if (step.kind === "rollback") {
                const to = Math.max(finalized, block - step.back);
                await sql.begin((tx) => rollbackJournal(tx, "app", tables, CHAIN, to));
                store.invalidate();
                expect(await dump()).toEqual(snapshots.get(to));
                for (const k of [...snapshots.keys()]) if (k > to) snapshots.delete(k);
                block = to;
              } else {
                const to = Math.max(finalized, block - step.back);
                await sql.begin((tx) => pruneJournal(tx, "app", tables, CHAIN, to));
                finalized = to;
                expect(await dump()).toEqual(snapshots.get(block)); // pruning changes nothing visible
              }
              // A fresh store (a restart) must see the same rows as the one in use.
              if (block % 3 === 0) store = await BufferedStore.open({ sql, schema: "app", tables });
            }
            // Rolling all the way back to the finalised block always works.
            await sql.begin((tx) => rollbackJournal(tx, "app", tables, CHAIN, finalized));
            expect(await dump()).toEqual(snapshots.get(finalized));
          },
        ),
        { numRuns: 120 },
      );
    } finally {
      await sql.end();
      await db.drop();
    }
  }, 300_000);
});
