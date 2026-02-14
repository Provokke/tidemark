import { describe, expect, it } from "vitest";
import {
  deserializeSchema,
  index,
  onchainTable,
  primaryKey,
  relations,
  relationsOf,
  serializeSchema,
  t,
  tableDdl,
  tablesOf,
  uniqueIndex,
} from "../src/index.js";

const pool = onchainTable(
  "pool",
  {
    id: t.hex().primaryKey(),
    fee: t.integer().notNull(),
    label: t.text(),
    meta: t.json(),
    at: t.timestamp().notNull(),
  },
  (p) => ({ byFee: index().on(p.fee), uniqueLabel: uniqueIndex().on(p.label) }),
  { history: true },
);
const swap = onchainTable(
  "swap",
  { poolId: t.hex().notNull(), n: t.bigint().notNull(), amount: t.real(), ok: t.boolean() },
  (s) => ({ pk: primaryKey({ columns: [s.poolId, s.n] }) }),
);
const schema = {
  pool,
  swap,
  poolRelations: relations(pool, ({ many }) => ({
    swaps: many(swap, { fields: ["id"], references: ["poolId"] }),
  })),
  swapRelations: relations(swap, ({ one }) => ({
    pool: one(pool, { fields: ["poolId"], references: ["id"] }),
  })),
};

describe("schema serialisation", () => {
  it("round-trips tables, keys, indexes, options and relations", () => {
    const serialized = serializeSchema(tablesOf(schema), relationsOf(schema));
    const back = deserializeSchema(JSON.parse(JSON.stringify(serialized)) as typeof serialized);
    expect(serializeSchema(tablesOf(back), relationsOf(back))).toEqual(serialized);
    for (const [a, b] of tablesOf(schema).map((table, i) => [table, tablesOf(back)[i]] as const)) {
      expect(b === undefined ? [] : tableDdl(b, "x")).toEqual(tableDdl(a, "x"));
    }
    expect(relationsOf(back).get("swap")?.pool?.target.name).toBe("pool");
  });

  it("refuses unknown versions and types", () => {
    expect(() => deserializeSchema({ version: 2 } as never)).toThrow(/version/);
    expect(() =>
      deserializeSchema({
        version: 1,
        tables: [
          {
            name: "x",
            columns: [{ key: "a", type: "nope", notNull: true }],
            primaryKey: ["a"],
            indexes: [],
            options: {},
          },
        ],
        relations: [],
      }),
    ).toThrow(/unknown column type/);
  });
});
