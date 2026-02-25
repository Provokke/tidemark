import { createTestDatabase } from "@tidemark/testing";
import { describe, expect, it } from "vitest";
import { advisoryKey, bytesToHex, connect, hexToBytes, ident, migrate } from "../src/index.js";

describe("migrate", () => {
  it("applies pending migrations once, in order, and refuses drift", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url, { max: 4 });
    try {
      const m1 = { id: "0001", sql: "create table t1 (id int)" };
      const m2 = { id: "0002", sql: "insert into t1 values (1)" };
      expect(await migrate(sql, "test", [m2, m1])).toEqual(["0001", "0002"]);
      expect(await migrate(sql, "test", [m1, m2])).toEqual([]);

      // Concurrent runs: the advisory lock serialises them and only one applies 0003.
      const m3 = { id: "0003", sql: "insert into t1 values (3)" };
      const results = await Promise.all([1, 2, 3].map(() => migrate(sql, "test", [m1, m2, m3])));
      expect(results.flat()).toEqual(["0003"]);
      const rows = await sql<{ id: number }[]>`select id from t1 order by id`;
      expect(rows.map((r) => r.id)).toEqual([1, 3]);

      await expect(migrate(sql, "test", [m1, { ...m2, sql: "select 1" }, m3])).rejects.toThrow(/edited/);
      await expect(migrate(sql, "test", [m1, m2])).rejects.toThrow(/does not know/);
      // Namespaces are independent.
      expect(
        await migrate(
          sql,
          "other",
          [m1].map((m) => ({ ...m, sql: "create table t2 (id int)" })),
        ),
      ).toEqual(["0001"]);
    } finally {
      await sql.end();
      await db.drop();
    }
  });

  it("migrates different namespaces at once on a fresh database", async () => {
    // Both create the shared bookkeeping schema: unserialised, one fails with a unique violation.
    const db = await createTestDatabase();
    const sql = connect(db.url, { max: 8 });
    try {
      const results = await Promise.all(
        ["a", "b", "c", "d"].map((ns) => migrate(sql, ns, [{ id: "0001", sql: `create schema ns_${ns}` }])),
      );
      expect(results).toEqual([["0001"], ["0001"], ["0001"], ["0001"]]);
    } finally {
      await sql.end();
      await db.drop();
    }
  });

  it("returns int8 as bigint", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      const [row] = await sql<{ v: bigint }[]>`select 9007199254740993::int8 as v`;
      expect(row?.v).toBe(9007199254740993n);
    } finally {
      await sql.end();
      await db.drop();
    }
  });
});

describe("helpers", () => {
  it("converts hex and quotes identifiers", () => {
    expect(bytesToHex(hexToBytes("0x00ff10"))).toBe("0x00ff10");
    expect(() => hexToBytes("0x123")).toThrow(RangeError);
    expect(ident('we"ird')).toBe('"we""ird"');
    expect(advisoryKey("a")).toBe(advisoryKey("a"));
    expect(advisoryKey("a")).not.toBe(advisoryKey("b"));
  });
});
