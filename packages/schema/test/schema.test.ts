import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type InferInsert,
  type InferSelect,
  completeRow,
  index,
  normalizePatch,
  onchainTable,
  primaryKey,
  primaryKeyOf,
  t,
  tableDdl,
  toSqlName,
  toCopyLine,
} from "../src/index.js";

const pool = onchainTable(
  "pool",
  {
    id: t.hex().primaryKey(),
    token0: t.hex().notNull(),
    fee: t.integer().notNull(),
    liquidity: t.bigint().notNull().default(0n),
    sqrtPriceX96: t.bigint(),
    tokenURI: t.text(),
  },
  (p) => ({ byToken: index().on(p.token0, p.fee) }),
);

describe("onchainTable", () => {
  it("maps camelCase keys to snake_case SQL names", () => {
    expect(toSqlName("sqrtPriceX96")).toBe("sqrt_price_x96");
    expect(toSqlName("tokenURI")).toBe("token_uri");
    expect(toSqlName("token0")).toBe("token0");
    expect(toSqlName("ownerOfNFTId")).toBe("owner_of_nft_id");
    expect(pool.columnList.map((c) => c.sqlName)).toEqual([
      "id",
      "token0",
      "fee",
      "liquidity",
      "sqrt_price_x96",
      "token_uri",
    ]);
  });

  it("generates DDL with not-null, the primary key and indexes", () => {
    expect(tableDdl(pool, "app")).toEqual([
      'create table "app"."pool" (\n  "id" bytea not null,\n  "token0" bytea not null,\n  "fee" integer not null,\n  "liquidity" numeric(78,0) not null,\n  "sqrt_price_x96" numeric(78,0),\n  "token_uri" text,\n  primary key ("id")\n)',
      'create index "pool_by_token" on "app"."pool" ("token0", "fee")',
    ]);
  });

  it("supports composite primary keys", () => {
    const balance = onchainTable(
      "balance",
      { token: t.hex().notNull(), owner: t.hex().notNull(), amount: t.bigint().notNull() },
      (b) => ({ pk: primaryKey({ columns: [b.token, b.owner] }) }),
    );
    expect(balance.primaryKey).toEqual(["token", "owner"]);
    const a = primaryKeyOf(balance, { token: "0xAA", owner: "0xbb" });
    const b = primaryKeyOf(balance, { owner: "0xBB", token: "0xaa" });
    expect(a.text).toBe(b.text);
    expect(a.values).toEqual({ token: "0xaa", owner: "0xbb" });
  });

  it("refuses bad definitions", () => {
    expect(() => onchainTable("Pool", { id: t.text().primaryKey() })).toThrow(/snake_case/);
    expect(() => onchainTable("p", { id: t.text() })).toThrow(/exactly one primary key/);
    expect(() => onchainTable("p", { a: t.text().primaryKey(), b: t.text().primaryKey() })).toThrow(
      /composite/,
    );
    expect(() => onchainTable("p", { fooBar: t.text().primaryKey(), foo_bar: t.text() })).toThrow(/both map/);
  });

  it("infers select and insert types", () => {
    type Select = InferSelect<typeof pool>;
    type Insert = InferInsert<typeof pool>;
    expectTypeOf<Select["id"]>().toEqualTypeOf<`0x${string}`>();
    expectTypeOf<Select["sqrtPriceX96"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Select["liquidity"]>().toEqualTypeOf<bigint>();
    expectTypeOf<{ id: `0x${string}`; token0: `0x${string}`; fee: number }>().toExtend<Insert>();
    expectTypeOf<{ id: `0x${string}` }>().not.toExtend<Insert>();
  });
});

describe("rows", () => {
  it("completes rows with defaults and normalises values", () => {
    expect(completeRow(pool, { id: "0xABCD", token0: "0x01", fee: 3000 })).toEqual({
      id: "0xabcd",
      token0: "0x01",
      fee: 3000,
      liquidity: 0n,
      sqrtPriceX96: null,
      tokenURI: null,
    });
  });

  it("refuses wrong types, missing values and unknown columns", () => {
    expect(() => completeRow(pool, { id: "0x01", token0: "0x01" })).toThrow(/pool.fee: is not null/);
    expect(() => completeRow(pool, { id: "0x01", token0: "0x01", fee: 1.5 })).toThrow(/32-bit integer/);
    expect(() => completeRow(pool, { id: "0x1", token0: "0x01", fee: 1 })).toThrow(/even-length/);
    expect(() => completeRow(pool, { id: "0x01", token0: "0x01", fee: 1, liquidity: 10n ** 78n })).toThrow(
      /78 digits/,
    );
    expect(() => completeRow(pool, { id: "0x01", token0: "0x01", fee: 1, nope: 1 })).toThrow(
      /unknown column/,
    );
    expect(() => normalizePatch(pool, { id: "0x02" })).toThrow(/primary key/);
  });

  it("escapes COPY text", () => {
    const notes = onchainTable("notes", { id: t.text().primaryKey(), body: t.text(), data: t.hex() });
    expect(toCopyLine(notes, { id: "a\tb", body: "x\\y\nz\r", data: "0x00ff" })).toBe(
      "a\\tb\tx\\\\y\\nz\\r\t\\\\x00ff\n",
    );
    expect(toCopyLine(notes, { id: "a", body: null, data: null })).toBe("a\t\\N\t\\N\n");
  });
});
