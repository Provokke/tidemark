import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AdaptiveRangeSize } from "../src/range-size.js";

/** Drives the sizer against a provider that refuses any range wider than `limit`. */
function run(max: number, limit: number, ranges: number) {
  const sizer = new AdaptiveRangeSize(max);
  const requested: number[] = [];
  let refusals = 0;
  let read = 0;
  while (read < ranges) {
    const size = sizer.size;
    requested.push(size);
    if (size > limit) {
      refusals++;
      expect(sizer.refused()).toBe(true);
    } else {
      sizer.succeeded();
      read++;
    }
  }
  return { requested, refusals, sizer };
}

describe("AdaptiveRangeSize", () => {
  it("stays within [1, max]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.oneof(fc.constant<"ok">("ok"), fc.option(fc.integer({ min: -5, max: 200_000 }))), {
          maxLength: 200,
        }),
        (max, events) => {
          const sizer = new AdaptiveRangeSize(max);
          for (const event of events) {
            if (event === "ok") sizer.succeeded();
            else sizer.refused(event ?? undefined);
            expect(sizer.size).toBeGreaterThanOrEqual(1);
            expect(sizer.size).toBeLessThanOrEqual(max);
          }
        },
      ),
    );
  });

  it("against a fixed limit, never oscillates: refusals are logarithmic, not per range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (max, limit) => {
          const { refusals, requested } = run(max, limit, 200);
          expect(refusals).toBeLessThanOrEqual(Math.ceil(Math.log2(max)) + 2);
          // The last hundred ranges are all accepted: the size has settled.
          expect(requested.slice(-100).every((size) => size <= limit)).toBe(true);
        },
      ),
    );
  });

  it("grows back to max when nothing is refused", () => {
    const sizer = new AdaptiveRangeSize(1_000, 1);
    for (let i = 0; i < 10; i++) sizer.succeeded();
    expect(sizer.size).toBe(1_000);
  });

  it("caps growth at the last size that fitted once a larger one is refused", () => {
    const sizer = new AdaptiveRangeSize(1_000, 100);
    sizer.succeeded(); // 100 fitted, try 200
    expect(sizer.size).toBe(200);
    sizer.refused(); // 200 refused: ceiling becomes 100
    expect(sizer.ceiling).toBe(100);
    expect(sizer.size).toBe(100);
    sizer.succeeded();
    sizer.succeeded();
    expect(sizer.size).toBe(100);
  });

  it("takes a provider's smaller suggestion and ignores a larger or invalid one", () => {
    const sizer = new AdaptiveRangeSize(2_000);
    sizer.refused(300);
    expect(sizer.size).toBe(300);
    sizer.refused(5_000);
    expect(sizer.size).toBe(150);
    sizer.refused(Number.NaN);
    expect(sizer.size).toBe(75);
  });

  it("reports that a single block cannot shrink", () => {
    const sizer = new AdaptiveRangeSize(1);
    expect(sizer.refused()).toBe(false);
    expect(sizer.size).toBe(1);
  });
});
