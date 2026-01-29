import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Interval,
  contains,
  contiguousEnd,
  fromPgMultirange,
  intersect,
  normalize,
  size,
  subtract,
  toPgMultirange,
  union,
} from "../src/intervals.js";

// Small universe so random interval sets overlap often; the model is a plain Set of blocks.
const UNIVERSE = 64;
const interval: fc.Arbitrary<Interval> = fc
  .tuple(fc.nat(UNIVERSE), fc.nat(UNIVERSE))
  .map(([a, b]) => (a <= b ? [a, b] : [b, a]));
const intervals = fc.array(interval, { maxLength: 8 });

const toSet = (list: readonly Interval[]) => {
  const set = new Set<number>();
  for (const [start, end] of list) for (let b = start; b <= end; b++) set.add(b);
  return set;
};
const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

function isCanonical(list: readonly Interval[]): boolean {
  return list.every(([start, end], i) => {
    const prev = list[i - 1];
    return start <= end && (prev === undefined || start > prev[1] + 1);
  });
}

describe("intervals", () => {
  it("normalise keeps the same blocks in canonical form", () => {
    fc.assert(
      fc.property(intervals, (list) => {
        const out = normalize(list);
        expect(isCanonical(out)).toBe(true);
        expect(sorted(toSet(out))).toEqual(sorted(toSet(list)));
      }),
    );
  });

  it("union, subtract and intersect agree with set operations", () => {
    fc.assert(
      fc.property(intervals, intervals, (a, b) => {
        const A = toSet(a);
        const B = toSet(b);
        const u = union(a, b);
        const s = subtract(a, b);
        const i = intersect(a, b);
        for (const out of [u, s, i]) expect(isCanonical(out)).toBe(true);
        expect(sorted(toSet(u))).toEqual(sorted(new Set([...A, ...B])));
        expect(sorted(toSet(s))).toEqual(sorted(new Set([...A].filter((x) => !B.has(x)))));
        expect(sorted(toSet(i))).toEqual(sorted(new Set([...A].filter((x) => B.has(x)))));
      }),
      { numRuns: 2_000 },
    );
  });

  it("size, contains and contiguousEnd agree with the set", () => {
    fc.assert(
      fc.property(intervals, fc.nat(UNIVERSE + 1), (list, from) => {
        const set = toSet(list);
        expect(size(list)).toBe(set.size);
        expect(contains(list, from)).toBe(set.has(from));
        let end = from - 1;
        while (set.has(end + 1)) end++;
        expect(contiguousEnd(list, from)).toBe(end);
      }),
    );
  });

  it("round-trips through the Postgres multirange literal", () => {
    fc.assert(
      fc.property(intervals, (list) => {
        expect(fromPgMultirange(toPgMultirange(list))).toEqual(normalize(list));
      }),
    );
    expect(
      toPgMultirange([
        [1, 3],
        [10, 20],
      ]),
    ).toBe("{[1,4),[10,21)}");
    expect(fromPgMultirange("{}")).toEqual([]);
    expect(fromPgMultirange("{[1,3),[12,20)}")).toEqual([
      [1, 2],
      [12, 19],
    ]);
  });

  it("refuses intervals that are not block ranges", () => {
    expect(() => normalize([[5, 4]])).toThrow(RangeError);
    expect(() => normalize([[-1, 4]])).toThrow(RangeError);
    expect(() => normalize([[0, 1.5]])).toThrow(RangeError);
    expect(() => fromPgMultirange("{[1,)}")).toThrow(RangeError);
    expect(() => fromPgMultirange("[1,2)")).toThrow(RangeError);
  });
});
