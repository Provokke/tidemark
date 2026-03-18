import {
  AdaptiveRangeSize,
  type Interval,
  type LogFilter,
  contiguousEnd,
  logFilterHash,
  normalize,
  normalizeLogFilter,
  subtract,
} from "@tidemark/core";
import {
  NotYetAvailableError,
  RangeTooLargeError,
  type RpcBlockHeader,
  type RpcLog,
  type RpcPool,
  type RpcTrace,
  type VerifyMode,
  effectiveCalls,
  logsFromVerifiedReceipts,
  verifyLogsWithBloom,
} from "@tidemark/rpc";
import {
  type BlockSourceSpec,
  type FactoryLogSourceSpec,
  type FactorySpec,
  type SourceSpec,
  type TraceSourceSpec,
  childAddress,
  factoryHash,
  factoryLogMatches,
  factoryParentFilter,
  intervalBlocks,
  sourceChainId,
  sourceHash,
} from "./sources.js";
import { InconsistentChainDataError, type SyncStore } from "./store.js";

/** A plain log source (the original form, still accepted everywhere a source spec is). */
export interface LogSource {
  readonly filter: LogFilter;
  readonly startBlock: number;
  /** Inclusive. Omit to follow the chain. */
  readonly endBlock?: number;
}

export type AnySource = LogSource | SourceSpec;

export const toSpec = (source: AnySource): SourceSpec =>
  "kind" in source
    ? source
    : {
        kind: "log",
        filter: source.filter,
        startBlock: source.startBlock,
        ...(source.endBlock === undefined ? {} : { endBlock: source.endBlock }),
      };

export interface FilterProgress {
  /** The source's cache key (a log filter hash for log sources). */
  readonly filterHash: string;
  readonly startBlock: number;
  /** The last block cached without a gap from `startBlock`, or `startBlock - 1`. */
  readonly cachedThrough: number;
}

export interface FilterReport {
  readonly filterHash: string;
  readonly fetchedRanges: number;
  readonly fetchedBlocks: number;
  readonly logs: number;
  readonly refusals: number;
}

export interface SyncReport {
  readonly target: number;
  readonly filters: readonly FilterReport[];
  /** True when every endpoint was behind the target and some ranges were left for later. */
  readonly incomplete: boolean;
}

export interface HistoricalSyncOptions {
  readonly pool: RpcPool;
  readonly store: SyncStore;
  readonly sources: readonly AnySource[];
  /** Largest `eth_getLogs` / `trace_filter` range to try. */
  readonly maxLogRange?: number;
  /** Sources synced at once. */
  readonly concurrency?: number;
  /** Above this many factory children, child logs are fetched by topic and filtered locally. */
  readonly maxAddressesPerFilter?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: FilterProgress) => void;
  /**
   * How far to trust `eth_getLogs` answers. `head-check` (the pool's default) refuses ranges past
   * the node's head; `bloom` also checks every block's logs against its header's bloom and refetches
   * blocks a range answer left out; `receipts-root` derives logs from receipts proven against each
   * header (one `eth_getBlockReceipts` per block the bloom does not rule out).
   */
  readonly verify?: VerifyMode;
  /** Told about blocks `bloom` mode had to refetch. */
  readonly onRepair?: (event: { readonly filterHash: string; readonly blocks: readonly number[] }) => void;
}

interface Group {
  readonly spec: SourceSpec;
  readonly hash: string;
  readonly required: Interval[];
  readonly startBlock: number;
}

type Report = {
  filterHash: string;
  fetchedRanges: number;
  fetchedBlocks: number;
  logs: number;
  refusals: number;
};

/**
 * Fills the sync cache for a set of sources up to a target block, which must be finalised: the
 * cache treats everything it holds as immutable. Handles every source kind: logs, logs of factory
 * children, interval blocks and call traces.
 *
 * Each range is committed atomically, so a crash or an abort loses at most the range in flight
 * and the next run resumes from the gaps. Factories sync in two phases: the factory's own events
 * first, then the logs of every child it announced.
 */
export class HistoricalSync {
  readonly #options: HistoricalSyncOptions;

  constructor(options: HistoricalSyncOptions) {
    this.#options = options;
    for (const source of options.sources) {
      const chainId = sourceChainId(toSpec(source));
      if (chainId !== options.pool.chainId) {
        throw new Error(`source for chain ${chainId} given to the pool for chain ${options.pool.chainId}`);
      }
    }
  }

  #groups(target: number, specs: readonly SourceSpec[]): Group[] {
    const groups = new Map<string, { spec: SourceSpec; ranges: Interval[]; startBlock: number }>();
    for (const spec of specs) {
      const end = Math.min(spec.endBlock ?? Number.MAX_SAFE_INTEGER, target);
      const hash = sourceHash(spec);
      const group = groups.get(hash) ?? { spec, ranges: [], startBlock: spec.startBlock };
      group.startBlock = Math.min(group.startBlock, spec.startBlock);
      if (spec.startBlock <= end) group.ranges.push([spec.startBlock, end]);
      groups.set(hash, group);
    }
    return [...groups].map(([hash, g]) => ({
      spec: g.spec,
      hash,
      required: normalize(g.ranges),
      startBlock: g.startBlock,
    }));
  }

  async run(target: number): Promise<SyncReport> {
    const { store, pool } = this.#options;
    await store.ensureChain(pool.chainId);
    const specs = this.#options.sources.map(toSpec);
    // A factory's own announcing events are an implicit log source, synced in the first phase.
    const parents: SourceSpec[] = specs
      .filter((s): s is FactoryLogSourceSpec => s.kind === "factoryLog")
      .map((s) => ({
        kind: "log",
        filter: factoryParentFilter(s.factory),
        startBlock: s.startBlock,
        ...(s.endBlock === undefined ? {} : { endBlock: s.endBlock }),
      }));
    const first = this.#groups(target, [...specs.filter((s) => s.kind !== "factoryLog"), ...parents]);
    const second = this.#groups(
      target,
      specs.filter((s) => s.kind === "factoryLog"),
    );

    const reports: FilterReport[] = [];
    const state = { incomplete: false };
    for (const phase of [first, second]) {
      if (state.incomplete && phase === second) break; // children need their factory's events first
      const queue = [...phase];
      const workers = Array.from({ length: Math.max(1, this.#options.concurrency ?? 4) }, async () => {
        for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
          const result = await this.#syncGroup(group, target);
          reports.push(result.report);
          state.incomplete ||= result.incomplete;
        }
      });
      await Promise.all(workers);
    }
    return {
      target,
      filters: reports.sort((a, b) => (a.filterHash < b.filterHash ? -1 : 1)),
      incomplete: state.incomplete,
    };
  }

  async #syncGroup(group: Group, target: number): Promise<{ report: FilterReport; incomplete: boolean }> {
    const { store, pool, signal } = this.#options;
    const cached = await store.cachedIntervals(pool.chainId, group.hash);
    const gaps = subtract(group.required, cached);
    const report: Report = {
      filterHash: group.hash,
      fetchedRanges: 0,
      fetchedBlocks: 0,
      logs: 0,
      refusals: 0,
    };
    let have = [...cached];
    const progress = () =>
      this.#options.onProgress?.({
        filterHash: group.hash,
        startBlock: group.startBlock,
        cachedThrough: contiguousEnd(have, group.startBlock),
      });
    const committed = (from: number, to: number) => {
      report.fetchedRanges++;
      report.fetchedBlocks += to - from + 1;
      have = normalize([...have, [from, to]]);
      progress();
    };

    if (group.spec.kind === "block") {
      await this.#syncBlocks(group.spec, group.hash, gaps, committed);
      if (gaps.length === 0) progress();
      return { report, incomplete: false };
    }

    let children: Map<string, number> | undefined;
    if (group.spec.kind === "factoryLog")
      children = await this.#refreshChildren(group.spec.factory, group.startBlock, target);

    const sizer = new AdaptiveRangeSize(this.#options.maxLogRange ?? 2_000);
    for (const [gapStart, gapEnd] of gaps) {
      let cursor = gapStart;
      while (cursor <= gapEnd) {
        signal?.throwIfAborted();
        const to = Math.min(gapEnd, cursor + sizer.size - 1);
        let fetched: { logs: RpcLog[]; traces: RpcTrace[] };
        try {
          fetched = await this.#fetch(group.spec, cursor, to, children);
        } catch (error) {
          if (error instanceof RangeTooLargeError) {
            report.refusals++;
            if (!sizer.refused(error.suggestedSize)) throw error;
            continue;
          }
          if (error instanceof NotYetAvailableError) return { report, incomplete: true };
          throw error;
        }
        sizer.succeeded();
        const headers = await this.#headersFor([...fetched.logs, ...fetched.traces]);
        await store.commitSourceRange({
          chainId: pool.chainId,
          sourceHash: group.hash,
          spec: group.spec,
          fromBlock: cursor,
          toBlock: to,
          logs: fetched.logs,
          traces: fetched.traces,
          headers,
        });
        report.logs += fetched.logs.length + fetched.traces.length;
        committed(cursor, to);
        cursor = to + 1;
      }
    }
    if (gaps.length === 0) progress();
    return { report, incomplete: false };
  }

  async #fetch(
    spec: SourceSpec,
    from: number,
    to: number,
    children: Map<string, number> | undefined,
  ): Promise<{ logs: RpcLog[]; traces: RpcTrace[] }> {
    const pool = this.#options.pool;
    if (spec.kind === "log") return { logs: await this.#logs(spec.filter, from, to), traces: [] };
    if (spec.kind === "trace") return { logs: [], traces: await this.#fetchTraces(spec, from, to) };
    if (spec.kind === "factoryLog") {
      const known = children ?? new Map<string, number>();
      const addresses = [...known].filter(([, created]) => created <= to).map(([a]) => a as `0x${string}`);
      if (addresses.length === 0) return { logs: [], traces: [] };
      const byAddress = addresses.length <= (this.#options.maxAddressesPerFilter ?? 1_000);
      const filter = normalizeLogFilter({
        chainId: pool.chainId,
        address: byAddress ? addresses : null,
        topics: spec.topics,
      });
      const logs = await this.#logs(filter, from, to);
      return { logs: logs.filter((log) => factoryLogMatches(spec, known, log)), traces: [] };
    }
    throw new Error(`no fetch for ${spec.kind}`);
  }

  /** A filter's logs over a finalised range, checked as the chain's verify mode asks. */
  async #logs(filter: LogFilter, from: number, to: number): Promise<RpcLog[]> {
    const pool = this.#options.pool;
    const mode = this.#options.verify ?? "head-check";
    if (mode === "receipts-root") return logsFromVerifiedReceipts(pool, filter, from, to);
    const logs = await pool.getLogs(filter, from, to);
    if (mode !== "bloom") return logs;
    const checked = await verifyLogsWithBloom(pool, filter, from, to, logs);
    if (checked.report.repaired.length > 0) {
      this.#options.onRepair?.({ filterHash: logFilterHash(filter), blocks: checked.report.repaired });
    }
    return checked.logs;
  }

  async #fetchTraces(spec: TraceSourceSpec, from: number, to: number): Promise<RpcTrace[]> {
    const pool = this.#options.pool;
    const candidates = (await pool.traceFilter(spec.to, from, to)).filter(
      (t) =>
        spec.selectors === null ||
        spec.selectors.includes(t.input.slice(0, 10).toLowerCase() as `0x${string}`),
    );
    // A nested call may sit under a frame that reverted: check its ancestors in the full tree.
    const nested = [
      ...new Set(candidates.filter((t) => t.traceAddress.length > 0).map((t) => t.transactionHash)),
    ];
    const trees = (await Promise.all(nested.map((hash) => pool.traceTransaction(hash)))).flat();
    return effectiveCalls(candidates, trees);
  }

  /** Re-reads a factory's children from its cached announcing logs. */
  async #refreshChildren(
    factory: FactorySpec,
    startBlock: number,
    target: number,
  ): Promise<Map<string, number>> {
    const { store, pool } = this.#options;
    const hash = factoryHash(factory);
    const logs = await store.readLogs(factoryParentFilter(factory), startBlock, target);
    const children: { address: `0x${string}`; createdBlock: number }[] = [];
    for (const log of logs) {
      const address = childAddress(factory, log);
      if (address !== undefined) children.push({ address, createdBlock: log.blockNumber });
    }
    await store.addFactoryChildren(pool.chainId, hash, children);
    return store.factoryChildren(pool.chainId, hash, target);
  }

  async #syncBlocks(
    spec: BlockSourceSpec,
    hash: string,
    gaps: readonly Interval[],
    committed: (from: number, to: number) => void,
  ) {
    const { store, pool, signal } = this.#options;
    const span = spec.interval * 500;
    for (const [gapStart, gapEnd] of gaps) {
      for (let from = gapStart; from <= gapEnd; from += span) {
        signal?.throwIfAborted();
        const to = Math.min(gapEnd, from + span - 1);
        const numbers = intervalBlocks(spec, from, to);
        const missing = await store.missingHeaders(pool.chainId, numbers);
        const headers = await pool.getBlockHeaders(missing);
        await store.commitSourceRange({
          chainId: pool.chainId,
          sourceHash: hash,
          spec,
          fromBlock: from,
          toBlock: to,
          headers,
        });
        committed(from, to);
      }
    }
  }

  /**
   * Headers for the blocks these logs and traces are in, fetching only those not cached. Each
   * header must carry the block hash the data reported; a mismatch means the provider served data
   * from different forks, which must not happen below the finalised block.
   */
  async #headersFor(items: readonly { blockNumber: number; blockHash: string }[]): Promise<RpcBlockHeader[]> {
    const { store, pool } = this.#options;
    const hashes = new Map<number, string>();
    for (const item of items) {
      const seen = hashes.get(item.blockNumber);
      if (seen !== undefined && seen !== item.blockHash) {
        throw new InconsistentChainDataError(`two hashes for block ${item.blockNumber} in one answer`);
      }
      hashes.set(item.blockNumber, item.blockHash);
    }
    const missing = await store.missingHeaders(pool.chainId, [...hashes.keys()]);
    const headers = await pool.getBlockHeaders(missing);
    for (const header of headers) {
      if (header.hash !== hashes.get(header.number)) {
        throw new InconsistentChainDataError(
          `block ${header.number}: header hash does not match the hash its data reported`,
        );
      }
    }
    return headers;
  }
}
