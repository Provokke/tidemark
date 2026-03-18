import { createHash } from "node:crypto";
import { type Hex, type LogFilter, logFilterHash, logMatches, normalizeLogFilter } from "@tidemark/core";
import type { RpcLog } from "@tidemark/rpc";

/**
 * Where a factory announces its children: the factory's addresses, the announcing event's
 * selector, and which part of that event holds the child address.
 */
export interface FactorySpec {
  readonly chainId: number;
  readonly address: readonly Hex[];
  readonly selector: Hex;
  /** `{ topic: 1 }` for the first indexed argument; `{ word: 0 }` for the first data word. */
  readonly location: { readonly topic: 1 | 2 | 3 } | { readonly word: number };
}

export interface LogSourceSpec {
  readonly kind: "log";
  readonly filter: LogFilter;
  readonly startBlock: number;
  readonly endBlock?: number;
}

/** Logs from every contract a factory has created, from the block that announced each one. */
export interface FactoryLogSourceSpec {
  readonly kind: "factoryLog";
  readonly factory: FactorySpec;
  readonly topics: LogFilter["topics"];
  readonly startBlock: number;
  readonly endBlock?: number;
}

/** Every `interval`-th block from `startBlock`. */
export interface BlockSourceSpec {
  readonly kind: "block";
  readonly chainId: number;
  readonly interval: number;
  readonly startBlock: number;
  readonly endBlock?: number;
}

/** Successful calls to the given addresses, optionally only to some function selectors. */
export interface TraceSourceSpec {
  readonly kind: "trace";
  readonly chainId: number;
  readonly to: readonly Hex[];
  readonly selectors: readonly Hex[] | null;
  readonly startBlock: number;
  readonly endBlock?: number;
}

export type SourceSpec = LogSourceSpec | FactoryLogSourceSpec | BlockSourceSpec | TraceSourceSpec;

const digest = (parts: unknown) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export function normalizeFactory(spec: FactorySpec): FactorySpec {
  return {
    chainId: spec.chainId,
    address: [...new Set(spec.address.map((a) => a.toLowerCase() as Hex))].sort(),
    selector: spec.selector.toLowerCase() as Hex,
    location: spec.location,
  };
}

export const factoryHash = (spec: FactorySpec): string => {
  const f = normalizeFactory(spec);
  return `fa_${digest(["factory", 1, f.chainId, f.address, f.selector, f.location])}`;
};

/** The filter for the factory's own announcing event. */
export const factoryParentFilter = (spec: FactorySpec): LogFilter =>
  normalizeLogFilter({ chainId: spec.chainId, address: spec.address, topics: [spec.selector] });

/** Reads the child address out of an announcing log, or undefined if the log does not carry one. */
export function childAddress(spec: FactorySpec, log: Pick<RpcLog, "topics" | "data">): Hex | undefined {
  let word: string | undefined;
  if ("topic" in spec.location) word = log.topics[spec.location.topic]?.slice(2);
  else {
    const start = 2 + spec.location.word * 64;
    word = log.data.length >= start + 64 ? log.data.slice(start, start + 64) : undefined;
  }
  if (word === undefined || word.length !== 64 || !word.startsWith("000000000000000000000000"))
    return undefined;
  return `0x${word.slice(24).toLowerCase()}`;
}

/** The cache key of a source: everything that decides which data it covers, and nothing else. */
export function sourceHash(source: SourceSpec): string {
  switch (source.kind) {
    case "log":
      return logFilterHash(source.filter);
    case "factoryLog":
      return `fl_${digest(["factoryLog", 1, factoryHash(source.factory), source.topics])}`;
    case "block":
      return `bk_${digest(["block", 1, source.chainId, source.interval, source.startBlock % source.interval])}`;
    case "trace":
      return `tr_${digest([
        "trace",
        1,
        source.chainId,
        [...new Set(source.to.map((a) => a.toLowerCase()))].sort(),
        source.selectors === null ? null : [...new Set(source.selectors.map((s) => s.toLowerCase()))].sort(),
      ])}`;
  }
}

export const sourceChainId = (source: SourceSpec): number =>
  source.kind === "log"
    ? source.filter.chainId
    : source.kind === "factoryLog"
      ? source.factory.chainId
      : source.chainId;

/** Whether a child log belongs to a factory source: right topics, from a child, at or after its announcement. */
export function factoryLogMatches(
  source: FactoryLogSourceSpec,
  children: ReadonlyMap<string, number>,
  log: Pick<RpcLog, "address" | "topics" | "blockNumber">,
): boolean {
  const created = children.get(log.address.toLowerCase());
  if (created === undefined || created > log.blockNumber) return false;
  return logMatches({ chainId: source.factory.chainId, address: null, topics: source.topics }, log);
}

/** Block numbers of an interval source inside [from, to]. */
export function intervalBlocks(source: BlockSourceSpec, from: number, to: number): number[] {
  const out: number[] = [];
  const offset = source.startBlock % source.interval;
  let first = Math.max(from, source.startBlock);
  const rem = (first - offset) % source.interval;
  if (rem !== 0) first += source.interval - rem;
  for (let n = first; n <= to; n += source.interval) out.push(n);
  return out;
}
