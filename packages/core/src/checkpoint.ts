/**
 * A checkpoint totally orders indexing events across chains. It is encoded as a fixed-width
 * decimal string so that plain string comparison (in TypeScript and in Postgres `text` columns
 * with the C collation) gives the same order as comparing the fields as a tuple.
 *
 * Layout, 75 characters:
 *
 * | field            | digits | max                       |
 * |------------------|--------|---------------------------|
 * | blockTimestamp   | 10     | 9999999999 (year 2286)    |
 * | chainId          | 16     | 9999999999999999          |
 * | blockNumber      | 16     | 9999999999999999          |
 * | transactionIndex | 16     | 9999999999999999          |
 * | eventType        | 1      | 9                         |
 * | eventIndex       | 16     | 9999999999999999          |
 */

/**
 * Orders events inside one transaction, and puts block ticks after every transaction in their
 * block. Codes leave gaps so a new kind can be slotted in without changing existing ones, which
 * would change every stored checkpoint.
 *
 * Within one transaction, traces sort before logs. The JSON-RPC API does not say how a trace
 * and a log interleave during execution, so this is a convention, not the execution order.
 */
export const EventType = {
  transaction: 1,
  trace: 3,
  log: 5,
  block: 9,
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface Checkpoint {
  readonly blockTimestamp: bigint;
  readonly chainId: bigint;
  readonly blockNumber: bigint;
  readonly transactionIndex: bigint;
  readonly eventType: EventType;
  readonly eventIndex: bigint;
}

const FIELDS = [
  ["blockTimestamp", 10],
  ["chainId", 16],
  ["blockNumber", 16],
  ["transactionIndex", 16],
  ["eventType", 1],
  ["eventIndex", 16],
] as const satisfies readonly (readonly [keyof Checkpoint, number])[];

export const CHECKPOINT_LENGTH = FIELDS.reduce((sum, [, digits]) => sum + digits, 0);

const EVENT_TYPES = new Set<number>(Object.values(EventType));

const MAX_BY_DIGITS = new Map<number, bigint>([1, 10, 16].map((d) => [d, 10n ** BigInt(d) - 1n]));

/** The largest value a field of `digits` decimal digits can hold. */
const maxFor = (digits: number): bigint => MAX_BY_DIGITS.get(digits) ?? 10n ** BigInt(digits) - 1n;

/** Block ticks use this transaction index so they sort after every transaction in the block. */
export const BLOCK_TICK_TRANSACTION_INDEX = maxFor(16);

export const ZERO_CHECKPOINT: Checkpoint = {
  blockTimestamp: 0n,
  chainId: 0n,
  blockNumber: 0n,
  transactionIndex: 0n,
  eventType: EventType.transaction,
  eventIndex: 0n,
};

export const MAX_CHECKPOINT: Checkpoint = {
  blockTimestamp: maxFor(10),
  chainId: maxFor(16),
  blockNumber: maxFor(16),
  transactionIndex: maxFor(16),
  eventType: EventType.block,
  eventIndex: maxFor(16),
};

export function encodeCheckpoint(checkpoint: Checkpoint): string {
  if (!EVENT_TYPES.has(checkpoint.eventType)) {
    throw new RangeError(`checkpoint eventType ${String(checkpoint.eventType)} is not a known EventType`);
  }
  let out = "";
  for (const [field, digits] of FIELDS) {
    const value = BigInt(checkpoint[field]);
    if (value < 0n || value > maxFor(digits)) {
      throw new RangeError(`checkpoint ${field} ${value} does not fit in ${digits} decimal digits`);
    }
    out += value.toString().padStart(digits, "0");
  }
  return out;
}

const DIGITS_ONLY = /^[0-9]+$/;

export function decodeCheckpoint(encoded: string): Checkpoint {
  if (encoded.length !== CHECKPOINT_LENGTH || !DIGITS_ONLY.test(encoded)) {
    throw new RangeError(`not a checkpoint: expected ${CHECKPOINT_LENGTH} decimal digits`);
  }
  const values: Record<string, bigint> = {};
  let offset = 0;
  for (const [field, digits] of FIELDS) {
    values[field] = BigInt(encoded.slice(offset, offset + digits));
    offset += digits;
  }
  const eventType = Number(values.eventType);
  if (!EVENT_TYPES.has(eventType)) {
    throw new RangeError(`checkpoint eventType ${eventType} is not a known EventType`);
  }
  return {
    blockTimestamp: values.blockTimestamp ?? 0n,
    chainId: values.chainId ?? 0n,
    blockNumber: values.blockNumber ?? 0n,
    transactionIndex: values.transactionIndex ?? 0n,
    eventType: eventType as EventType,
    eventIndex: values.eventIndex ?? 0n,
  };
}

/** Orders two encoded checkpoints: negative, zero or positive, like `Array.prototype.sort`. */
export function compareCheckpoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The checkpoint at the very end of a block: after its last transaction and its block tick. */
export function endOfBlockCheckpoint(block: { timestamp: bigint; chainId: bigint; number: bigint }): string {
  return encodeCheckpoint({
    blockTimestamp: block.timestamp,
    chainId: block.chainId,
    blockNumber: block.number,
    transactionIndex: BLOCK_TICK_TRANSACTION_INDEX,
    eventType: EventType.block,
    eventIndex: maxFor(16),
  });
}
