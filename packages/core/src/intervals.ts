/**
 * Sets of block numbers as sorted, disjoint, non-adjacent inclusive intervals. The sync cache
 * stores which blocks it holds for each filter this way, and subtracts what it holds from what a
 * build needs to find what to fetch.
 *
 * Block numbers are JavaScript numbers: every chain's height is far below 2^53, and interval math
 * runs in hot loops where bigint arithmetic would cost more than it buys. Inputs are checked to be
 * safe integers.
 */

/** Inclusive on both ends: `[5, 7]` is blocks 5, 6 and 7. */
export type Interval = readonly [start: number, end: number];

function check(interval: Interval): void {
  const [start, end] = interval;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`not a block interval: [${start}, ${end}]`);
  }
}

/** Sorts, merges overlapping and adjacent intervals, and checks every bound. */
export function normalize(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  intervals.forEach(check);
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

export function union(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  return normalize([...a, ...b]);
}

/** The blocks in `a` that are not in `b`. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = normalize(a);
  const right = normalize(b);
  const out: Interval[] = [];
  let j = 0;
  for (const [start, end] of left) {
    let cursor = start;
    while (j < right.length && (right[j]?.[1] ?? Infinity) < cursor) j++;
    let k = j;
    while (cursor <= end) {
      const cut = right[k];
      if (cut === undefined || cut[0] > end) {
        out.push([cursor, end]);
        break;
      }
      if (cut[0] > cursor) out.push([cursor, cut[0] - 1]);
      cursor = Math.max(cursor, cut[1] + 1);
      k++;
    }
  }
  return out;
}

export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  return subtract(a, subtract(a, b));
}

/** Number of blocks covered. */
export function size(intervals: readonly Interval[]): number {
  return normalize(intervals).reduce((sum, [start, end]) => sum + end - start + 1, 0);
}

export function contains(intervals: readonly Interval[], block: number): boolean {
  return normalize(intervals).some(([start, end]) => block >= start && block <= end);
}

/**
 * The end of the contiguous run starting at `from`, or `from - 1` if `from` itself is not
 * covered. Used to report how far a filter is cached without a gap.
 */
export function contiguousEnd(intervals: readonly Interval[], from: number): number {
  for (const [start, end] of normalize(intervals)) {
    if (start <= from && from <= end) return end;
  }
  return from - 1;
}

/** Postgres `int8multirange` literal. Postgres ranges are half-open, so the end is exclusive. */
export function toPgMultirange(intervals: readonly Interval[]): string {
  return `{${normalize(intervals)
    .map(([start, end]) => `[${start},${end + 1})`)
    .join(",")}}`;
}

const RANGE = /([[(])\s*(-?\d*)\s*,\s*(-?\d*)\s*([\])])/g;

/** Parses Postgres's text output for an `int8multirange` (always canonical `[a,b)` for integers). */
export function fromPgMultirange(text: string): Interval[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new RangeError(`not a multirange: ${text}`);
  }
  const out: Interval[] = [];
  for (const match of trimmed.matchAll(RANGE)) {
    const [, open, lower, upper, close] = match;
    if (lower === "" || upper === "" || lower === undefined || upper === undefined) {
      throw new RangeError(`unbounded ranges are not block intervals: ${text}`);
    }
    const start = Number(lower) + (open === "(" ? 1 : 0);
    const end = Number(upper) - (close === ")" ? 1 : 0);
    if (end >= start) out.push([start, end]);
  }
  return normalize(out);
}
