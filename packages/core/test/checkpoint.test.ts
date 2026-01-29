import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_LENGTH,
  type Checkpoint,
  EventType,
  MAX_CHECKPOINT,
  ZERO_CHECKPOINT,
  compareCheckpoints,
  decodeCheckpoint,
  encodeCheckpoint,
  endOfBlockCheckpoint,
} from "../src/checkpoint.js";

const field = (digits: number) => fc.bigInt({ min: 0n, max: 10n ** BigInt(digits) - 1n });

const checkpointArb: fc.Arbitrary<Checkpoint> = fc.record({
  blockTimestamp: field(10),
  chainId: field(16),
  blockNumber: field(16),
  transactionIndex: field(16),
  eventType: fc.constantFrom(...Object.values(EventType)),
  eventIndex: field(16),
});

/** Reference order: compare the fields as a tuple, in layout order. */
function tupleCompare(a: Checkpoint, b: Checkpoint): number {
  const keys = [
    "blockTimestamp",
    "chainId",
    "blockNumber",
    "transactionIndex",
    "eventType",
    "eventIndex",
  ] as const;
  for (const key of keys) {
    const x = BigInt(a[key]);
    const y = BigInt(b[key]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

describe("checkpoint", () => {
  it("round-trips through its encoding", () => {
    fc.assert(
      fc.property(checkpointArb, (checkpoint) => {
        expect(decodeCheckpoint(encodeCheckpoint(checkpoint))).toEqual(checkpoint);
      }),
    );
  });

  it("always encodes to the same width", () => {
    fc.assert(
      fc.property(checkpointArb, (checkpoint) => {
        expect(encodeCheckpoint(checkpoint)).toHaveLength(CHECKPOINT_LENGTH);
      }),
    );
    expect(CHECKPOINT_LENGTH).toBe(75);
  });

  it("orders encoded strings exactly as the field tuples", () => {
    fc.assert(
      fc.property(checkpointArb, checkpointArb, (a, b) => {
        expect(Math.sign(compareCheckpoints(encodeCheckpoint(a), encodeCheckpoint(b)))).toBe(
          tupleCompare(a, b),
        );
      }),
      { numRuns: 5_000 },
    );
  });

  it("orders checkpoints that differ only in the last field", () => {
    // Random pairs almost never share a prefix, so pin the shared-prefix case explicitly.
    fc.assert(
      fc.property(checkpointArb, field(16), field(16), (base, i, j) => {
        const a = encodeCheckpoint({ ...base, eventIndex: i });
        const b = encodeCheckpoint({ ...base, eventIndex: j });
        expect(Math.sign(compareCheckpoints(a, b))).toBe(i === j ? 0 : i < j ? -1 : 1);
      }),
    );
  });

  it("sorts every checkpoint between ZERO and MAX", () => {
    const zero = encodeCheckpoint(ZERO_CHECKPOINT);
    const max = encodeCheckpoint(MAX_CHECKPOINT);
    fc.assert(
      fc.property(checkpointArb, (checkpoint) => {
        const encoded = encodeCheckpoint(checkpoint);
        expect(compareCheckpoints(zero, encoded)).toBeLessThanOrEqual(0);
        expect(compareCheckpoints(encoded, max)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it("puts the end of a block after every event in it and before the next block", () => {
    fc.assert(
      fc.property(checkpointArb, (event) => {
        const block = { timestamp: event.blockTimestamp, chainId: event.chainId, number: event.blockNumber };
        const end = endOfBlockCheckpoint(block);
        expect(compareCheckpoints(encodeCheckpoint(event), end)).toBeLessThanOrEqual(0);
        if (event.blockTimestamp < MAX_CHECKPOINT.blockTimestamp) {
          const next = encodeCheckpoint({
            ...ZERO_CHECKPOINT,
            blockTimestamp: event.blockTimestamp + 1n,
            chainId: event.chainId,
            blockNumber: event.blockNumber + 1n > MAX_CHECKPOINT.blockNumber ? 0n : event.blockNumber + 1n,
          });
          expect(compareCheckpoints(end, next)).toBeLessThan(0);
        }
      }),
    );
  });

  it("refuses a field that does not fit its width", () => {
    expect(() => encodeCheckpoint({ ...ZERO_CHECKPOINT, blockTimestamp: 10n ** 10n })).toThrow(RangeError);
    expect(() => encodeCheckpoint({ ...ZERO_CHECKPOINT, chainId: -1n })).toThrow(RangeError);
    expect(() => encodeCheckpoint({ ...ZERO_CHECKPOINT, eventIndex: 10n ** 16n })).toThrow(RangeError);
  });

  it("refuses an unknown event type", () => {
    expect(() => encodeCheckpoint({ ...ZERO_CHECKPOINT, eventType: 4 as EventType })).toThrow(RangeError);
    const bad = encodeCheckpoint(ZERO_CHECKPOINT).split("");
    bad[58] = "4";
    expect(() => decodeCheckpoint(bad.join(""))).toThrow(RangeError);
  });

  it("refuses strings that are not checkpoints", () => {
    const good = encodeCheckpoint(ZERO_CHECKPOINT);
    expect(() => decodeCheckpoint(good.slice(1))).toThrow(RangeError);
    expect(() => decodeCheckpoint(`${good}0`)).toThrow(RangeError);
    expect(() => decodeCheckpoint(`-${good.slice(1)}`)).toThrow(RangeError);
    expect(() => decodeCheckpoint(good.replace(/0$/, "a"))).toThrow(RangeError);
  });
});
