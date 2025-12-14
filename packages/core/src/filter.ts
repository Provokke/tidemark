import { createHash } from "node:crypto";

export type Hex = `0x${string}`;

/**
 * A log filter as a source declares it. `address` and each topic position accept a single value,
 * a list (any of), or null/undefined (anything).
 */
export interface LogFilterInput {
  readonly chainId: number;
  readonly address?: Hex | readonly Hex[] | null;
  readonly topics?: readonly (Hex | readonly Hex[] | null)[];
}

/**
 * The canonical form: lowercase, sorted, de-duplicated, exactly four topic positions, `null` for
 * "anything". Two inputs that select the same logs normalise to the same value and hash.
 */
export interface LogFilter {
  readonly chainId: number;
  readonly address: readonly Hex[] | null;
  readonly topics: readonly [
    readonly Hex[] | null,
    readonly Hex[] | null,
    readonly Hex[] | null,
    readonly Hex[] | null,
  ];
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const TOPIC = /^0x[0-9a-f]{64}$/;

function canonicalList(value: Hex | readonly Hex[] | null | undefined, pattern: RegExp, what: string) {
  if (value === null || value === undefined) return null;
  const list = (typeof value === "string" ? [value] : value).map((v) => v.toLowerCase() as Hex);
  for (const v of list) {
    if (!pattern.test(v)) throw new RangeError(`not a valid ${what}: ${v}`);
  }
  // An empty list would match nothing, which is never what a source means.
  if (list.length === 0) throw new RangeError(`empty ${what} list`);
  return [...new Set(list)].sort();
}

export function normalizeLogFilter(input: LogFilterInput): LogFilter {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new RangeError(`not a chain id: ${input.chainId}`);
  }
  const topics = input.topics ?? [];
  if (topics.length > 4) throw new RangeError("a log filter has at most four topic positions");
  return {
    chainId: input.chainId,
    address: canonicalList(input.address, ADDRESS, "address"),
    topics: [
      canonicalList(topics[0], TOPIC, "topic"),
      canonicalList(topics[1], TOPIC, "topic"),
      canonicalList(topics[2], TOPIC, "topic"),
      canonicalList(topics[3], TOPIC, "topic"),
    ],
  };
}

/** A stable id for a normalised filter, used as the sync cache key. */
export function logFilterHash(filter: LogFilter): string {
  const canonical = JSON.stringify(["log", 1, filter.chainId, filter.address, filter.topics]);
  return `lf_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export interface LogLike {
  readonly address: string;
  readonly topics: readonly string[];
}

/** Whether a log matches a filter, with the same semantics as `eth_getLogs`. */
export function logMatches(filter: LogFilter, log: LogLike): boolean {
  if (filter.address !== null && !filter.address.includes(log.address.toLowerCase() as Hex)) return false;
  for (let i = 0; i < 4; i++) {
    const allowed = filter.topics[i];
    if (allowed === null || allowed === undefined) continue;
    const topic = log.topics[i];
    if (topic === undefined || !allowed.includes(topic.toLowerCase() as Hex)) return false;
  }
  return true;
}

/** The JSON-RPC `eth_getLogs` filter object for a block range, trailing wildcards dropped. */
export function toRpcLogFilter(filter: LogFilter, fromBlock: number, toBlock: number) {
  const topics: (Hex[] | null)[] = filter.topics.map((t) => (t === null ? null : [...t]));
  while (topics.length > 0 && topics[topics.length - 1] === null) topics.pop();
  return {
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    ...(filter.address === null ? {} : { address: [...filter.address] }),
    ...(topics.length === 0 ? {} : { topics }),
  };
}
