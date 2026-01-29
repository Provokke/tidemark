import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Hex, logFilterHash, logMatches, normalizeLogFilter, toRpcLogFilter } from "../src/filter.js";

const hexOf = (bytes: number) =>
  fc
    .uint8Array({ minLength: bytes, maxLength: bytes })
    .map((b): Hex => `0x${Buffer.from(b).toString("hex")}`);
const address = hexOf(20);
const topic = hexOf(32);
const upper = (h: Hex): Hex => `0x${h.slice(2).toUpperCase()}`;

describe("log filters", () => {
  it("normalise case, order and duplicates to the same hash", () => {
    fc.assert(
      fc.property(fc.array(address, { minLength: 1, maxLength: 5 }), topic, (addresses, t0) => {
        const a = normalizeLogFilter({ chainId: 1, address: addresses, topics: [t0] });
        const b = normalizeLogFilter({
          chainId: 1,
          address: [...addresses].reverse().map(upper).concat(addresses),
          topics: [[upper(t0), t0], null, null],
        });
        expect(b).toEqual(a);
        expect(logFilterHash(b)).toBe(logFilterHash(a));
      }),
    );
  });

  it("hashes different filters differently", () => {
    const base = { chainId: 1, address: "0x" + "11".repeat(20) } as const;
    const hashes = new Set([
      logFilterHash(normalizeLogFilter({ ...base, address: base.address as Hex })),
      logFilterHash(normalizeLogFilter({ ...base, address: base.address as Hex, chainId: 2 })),
      logFilterHash(normalizeLogFilter({ chainId: 1 })),
      logFilterHash(normalizeLogFilter({ chainId: 1, topics: [null, ("0x" + "22".repeat(32)) as Hex] })),
      logFilterHash(normalizeLogFilter({ chainId: 1, topics: [("0x" + "22".repeat(32)) as Hex] })),
    ]);
    expect(hashes.size).toBe(5);
  });

  it("matches logs with eth_getLogs semantics", () => {
    fc.assert(
      fc.property(address, address, fc.array(topic, { minLength: 1, maxLength: 4 }), (a, b, topics) => {
        const log = { address: upper(a), topics };
        expect(logMatches(normalizeLogFilter({ chainId: 1 }), log)).toBe(true);
        expect(logMatches(normalizeLogFilter({ chainId: 1, address: a }), log)).toBe(true);
        expect(logMatches(normalizeLogFilter({ chainId: 1, address: [b, a] }), log)).toBe(true);
        expect(logMatches(normalizeLogFilter({ chainId: 1, topics }), log)).toBe(true);
        if (a !== b) expect(logMatches(normalizeLogFilter({ chainId: 1, address: b }), log)).toBe(false);
        // A filter on a topic position the log does not have never matches.
        const tooLong = [...topics, ...Array<Hex | null>(4 - topics.length).fill(null)];
        tooLong[topics.length] = topics[0] ?? null;
        if (topics.length < 4) {
          expect(logMatches(normalizeLogFilter({ chainId: 1, topics: tooLong }), log)).toBe(false);
        }
      }),
    );
  });

  it("builds an RPC filter without trailing wildcards", () => {
    const t = ("0x" + "ab".repeat(32)) as Hex;
    expect(toRpcLogFilter(normalizeLogFilter({ chainId: 1, topics: [t] }), 16, 255)).toEqual({
      fromBlock: "0x10",
      toBlock: "0xff",
      topics: [[t]],
    });
    expect(toRpcLogFilter(normalizeLogFilter({ chainId: 1 }), 0, 0)).toEqual({
      fromBlock: "0x0",
      toBlock: "0x0",
    });
  });

  it("refuses malformed input", () => {
    expect(() => normalizeLogFilter({ chainId: 0 })).toThrow(RangeError);
    expect(() => normalizeLogFilter({ chainId: 1, address: "0x1234" })).toThrow(RangeError);
    expect(() => normalizeLogFilter({ chainId: 1, address: [] })).toThrow(RangeError);
    expect(() => normalizeLogFilter({ chainId: 1, topics: [null, null, null, null, null] })).toThrow(
      RangeError,
    );
  });
});
