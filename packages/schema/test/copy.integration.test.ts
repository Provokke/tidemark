import { connect, copyIn, ident } from "@tidemark/pg";
import { createTestDatabase } from "@tidemark/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { completeRow, fromDbRow, onchainTable, t, tableDdl, toCopyLine } from "../src/index.js";

const everything = onchainTable("everything", {
  id: t.integer().primaryKey(),
  hex: t.hex(),
  text: t.text(),
  big: t.bigint(),
  int: t.integer(),
  real: t.real(),
  flag: t.boolean(),
  at: t.timestamp(),
  doc: t.json(),
});

const nullable = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null });
const rowArb = fc.record({
  hex: nullable(fc.uint8Array({ maxLength: 40 }).map((b) => `0x${Buffer.from(b).toString("hex")}`)),
  // Every awkward character for COPY: tabs, newlines, backslashes, \N look-alikes, any Unicode.
  text: nullable(
    fc.oneof(
      fc.string({ unit: "grapheme" }),
      fc.constantFrom("\\N", "\\", "\t\n\r", "\\x41", "a\\\\b", ""),
      fc.string({ unit: fc.constantFrom("\\", "\t", "\n", "\r", "N", "x", "é", "😀") }),
    ),
  ),
  big: nullable(fc.bigInt({ min: -(10n ** 77n), max: 10n ** 77n })),
  int: nullable(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 })),
  real: nullable(fc.double({ noNaN: true, noDefaultInfinity: true })),
  flag: nullable(fc.boolean()),
  at: nullable(fc.integer({ min: 0, max: 4_000_000_000 }).map((s) => BigInt(s))),
  doc: nullable(fc.jsonValue()),
});

describe("COPY round trip", () => {
  it("every column type survives COPY text format and comes back equal", async () => {
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      await sql.unsafe("create schema app");
      for (const ddl of tableDdl(everything, "app")) await sql.unsafe(ddl);
      await fc.assert(
        fc.asyncProperty(fc.array(rowArb, { maxLength: 30 }), async (inputs) => {
          await sql.unsafe('truncate "app"."everything"');
          const rows = inputs.map((input, id) => completeRow(everything, { id, ...input }));
          await copyIn(
            sql,
            '"app"."everything"',
            everything.columnList.map((c) => ident(c.sqlName)),
            rows.map((r) => toCopyLine(everything, r)),
          );
          const back = await sql.unsafe('select * from "app"."everything" order by id');
          // -0 is stored as 0 by Postgres; normalise before comparing.
          const fix = (r: Record<string, unknown>) => ({ ...r, real: r.real === 0 ? 0 : r.real });
          expect(back.map((r) => fix(fromDbRow(everything, r)))).toEqual(rows.map(fix));
        }),
        { numRuns: 60 },
      );
    } finally {
      await sql.end();
      await db.drop();
    }
  });
});
