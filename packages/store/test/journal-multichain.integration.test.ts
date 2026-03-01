import { connect } from "@tidemark/pg";
import { type AnyTable, onchainTable, t, tableDdl } from "@tidemark/schema";
import { createTestDatabase } from "@tidemark/testing";
import { describe, expect, it } from "vitest";
import {
  BufferedStore,
  Db,
  enableJournal,
  journalDdl,
  rollbackJournal,
  rollbackJournalMany,
} from "../src/index.js";

const counter = onchainTable("counter", { id: t.integer().primaryKey(), value: t.integer().notNull() });
const tables: AnyTable[] = [counter];

describe("rolling back several chains together", () => {
  it("restores a row two chains changed to its state before the oldest change", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      await sql.unsafe("create schema app");
      for (const ddl of tableDdl(counter, "app")) await sql.unsafe(ddl);
      for (const ddl of journalDdl("app", tables)) await sql.unsafe(ddl);
      const store = await BufferedStore.open({ sql, schema: "app", tables });
      const api = new Db(store);
      const bump = async (chainId: number, block: number) => {
        await api.update(counter, { id: 1 }).set((r) => ({ value: r.value + 1 }));
        await store.flush(undefined, (tx) => enableJournal(tx, chainId, block));
      };
      const value = async () => (await sql`select value from app.counter where id = 1`)[0]?.value as number;

      await api.insert(counter).values({ id: 1, value: 1 });
      await store.flush();
      await bump(1, 101); // chain 1: 1 -> 2
      await bump(2, 51); //  chain 2: 2 -> 3
      await bump(1, 102); // chain 1: 3 -> 4

      // One pass over both chains: back to 1, before the oldest change.
      await sql.begin((tx) =>
        rollbackJournalMany(tx, "app", tables, [
          { chainId: 1, toBlock: 100 },
          { chainId: 2, toBlock: 50 },
        ]),
      );
      store.invalidate();
      expect(await value()).toBe(1);

      // Chain by chain gets it wrong: the second rollback restores a pre-image that already holds
      // the first chain's change. This is why omnichain reorgs roll back every chain at once.
      await bump(1, 101);
      await bump(2, 51);
      await bump(1, 102);
      await sql.begin((tx) => rollbackJournal(tx, "app", tables, 1, 100));
      await sql.begin((tx) => rollbackJournal(tx, "app", tables, 2, 50));
      store.invalidate();
      expect(await value()).toBe(2);
    } finally {
      await sql.end();
      await db.drop();
    }
  });
});
