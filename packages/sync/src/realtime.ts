import { type LogFilter, normalizeLogFilter } from "@tidemark/core";
import {
  type Finality,
  NotYetAvailableError,
  type RpcBlockHeader,
  type RpcLog,
  type RpcPool,
  type RpcTrace,
  effectiveCalls,
} from "@tidemark/rpc";
import { type AnySource, toSpec } from "./historical.js";
import {
  type FactoryLogSourceSpec,
  type SourceSpec,
  childAddress,
  factoryHash,
  factoryLogMatches,
  factoryParentFilter,
  intervalBlocks,
  sourceHash,
} from "./sources.js";
import type { SyncStore } from "./store.js";

export type Hex = `0x${string}`;

export interface RealtimeBlock {
  readonly header: RpcBlockHeader;
  /** Logs per source, in the order the sources were given. Empty for sources not active at this block. */
  readonly logs: readonly (readonly RpcLog[])[];
  /** Effective calls per source (trace sources only), in depth-first order. */
  readonly traces: readonly (readonly RpcTrace[])[];
  /** Per source: whether this block is one of a block source's interval blocks. */
  readonly ticks: readonly boolean[];
}

export type RealtimeEvent =
  | { readonly type: "block"; readonly block: RealtimeBlock }
  /** Every block above `ancestor` was replaced. Undo what they did before the new branch arrives. */
  | { readonly type: "reorg"; readonly ancestor: RpcBlockHeader; readonly dropped: readonly RpcBlockHeader[] }
  /** Every block at or below `header` is final and will never be reorged. */
  | { readonly type: "finalize"; readonly header: RpcBlockHeader };

/** A reorg reaches below the finalised block. The chain or the RPC is broken; never guess. */
export class UnrecoverableReorgError extends Error {
  override name = "UnrecoverableReorgError";
}

export interface RealtimeSyncOptions {
  readonly pool: RpcPool;
  readonly store: SyncStore;
  readonly sources: readonly AnySource[];
  readonly finality: Finality;
  /** The finalised block historical indexing reached. Realtime starts after it. */
  readonly base: RpcBlockHeader;
  /** Receives events one at a time; the next is not produced until this resolves. */
  readonly handle: (event: RealtimeEvent) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** Most new blocks to take in one step when catching up. */
  readonly maxStep?: number;
  /** Above this many factory children, child logs are read by topic and filtered locally. */
  readonly maxAddressesPerFilter?: number;
  /** Told the head on every poll, before following it. */
  readonly onHead?: (head: RpcBlockHeader) => void;
  readonly signal?: AbortSignal;
}

type BlockData = Omit<RealtimeBlock, "header"> & { readonly parents: readonly (readonly RpcLog[])[] };

interface FactoryState {
  readonly spec: FactoryLogSourceSpec["factory"];
  readonly hash: string;
  readonly parent: LogFilter;
  /** Child address to the block that announced it. */
  readonly children: Map<string, number>;
}

/**
 * Follows the chain above the finalised block. Keeps the unfinalised headers from the finalised
 * base to the tip and links every new block to its parent by hash, so a reorg is found the moment
 * a parent hash does not match, at any depth above finality. Everything a block contributes (logs,
 * factory children, traces, interval ticks) is read by block hash or checked against it.
 *
 * When the finalised block moves, the newly final blocks' data is written to the sync cache, so a
 * restart or a new build does not fetch it again.
 */
export class RealtimeSync {
  readonly #o: RealtimeSyncOptions;
  readonly #specs: readonly SourceSpec[];
  /** [base, ..., tip]. `base` is finalised; the rest are not. */
  #chain: RpcBlockHeader[];
  #byHash = new Map<string, RpcBlockHeader>();
  #data = new Map<string, BlockData>();
  #factories: FactoryState[] | undefined;
  /** Bumped by `rewind`, so a block in flight across a rewind is checked against its target. */
  #epoch = 0;
  /** The target of each rewind, by the epoch it started. */
  #rewinds: { epoch: number; to: number }[] = [];

  constructor(options: RealtimeSyncOptions) {
    this.#o = options;
    this.#specs = options.sources.map(toSpec);
    this.#chain = [options.base];
    this.#byHash.set(options.base.hash, options.base);
  }

  get tip(): RpcBlockHeader {
    return this.#chain[this.#chain.length - 1] ?? this.#o.base;
  }

  get finalized(): RpcBlockHeader {
    return this.#chain[0] ?? this.#o.base;
  }

  /**
   * Forgets every block above `block` without reporting a reorg: the caller has already undone
   * them and wants them delivered again. Used by omnichain ordering, where a reorg on one chain
   * rolls back the others to the same point in time.
   */
  rewind(block: number): void {
    const keep = this.#chain.findIndex((h) => h.number > block);
    if (keep >= 0) {
      for (const h of this.#chain.slice(Math.max(1, keep))) {
        this.#byHash.delete(h.hash);
        this.#data.delete(h.hash);
      }
      this.#chain = this.#chain.slice(0, Math.max(1, keep));
    }
    for (const f of this.#factories ?? []) {
      for (const [address, created] of f.children) if (created > block) f.children.delete(address);
    }
    // A block in flight right now is dropped only if it is above the target; one at or below it was
    // kept by the caller and must still be recorded.
    this.#epoch++;
    this.#rewinds.push({ epoch: this.#epoch, to: block });
    if (this.#rewinds.length > 64) this.#rewinds = this.#rewinds.slice(-32);
  }

  /** Whether a block in flight since `epoch` was cut off by a rewind. */
  #rewoundPast(epoch: number, block: number): boolean {
    if (epoch === this.#epoch) return false;
    return this.#rewinds.some((r) => r.epoch > epoch && block > r.to);
  }

  /** Polls until the signal aborts. Transient RPC trouble is retried on the next poll. */
  async run(): Promise<void> {
    const interval = this.#o.pollIntervalMs ?? 1_000;
    const signal = this.#o.signal;
    const aborted = () => signal?.aborted === true;
    while (!aborted()) {
      try {
        await this.tick();
      } catch (error) {
        if (error instanceof UnrecoverableReorgError) throw error;
        if (aborted()) break;
        if (!isTransient(error)) throw error;
      }
      await sleep(interval, signal);
    }
  }

  /** One poll: follow the head, then move finality. */
  async tick(): Promise<void> {
    const head = await this.#o.pool.getBlockHeader("latest");
    this.#o.onHead?.(head);
    await this.#follow(head);
    const finalized = await this.#o.pool.finalizedBlock(this.#o.finality);
    await this.#finalize(finalized);
  }

  async #follow(head: RpcBlockHeader): Promise<void> {
    const pool = this.#o.pool;
    for (;;) {
      this.#o.signal?.throwIfAborted();
      const epoch = this.#epoch;
      const tip = this.tip;
      if (head.hash === tip.hash) return;
      if (this.#byHash.has(head.hash)) return; // a node behind us; nothing new

      // Take at most maxStep blocks at a time, fetched by number, and check they link up.
      const maxStep = this.#o.maxStep ?? 100;
      const target =
        head.number - tip.number > maxStep ? await pool.getBlockHeader(tip.number + maxStep) : head;
      const between: number[] = [];
      for (let n = Math.max(tip.number + 1, this.finalized.number + 1); n < target.number; n++)
        between.push(n);
      const branch = [...(await pool.getBlockHeaders(between)), target];
      for (let i = 1; i < branch.length; i++) {
        if (branch[i]?.parentHash !== branch[i - 1]?.hash) return; // nodes disagreed mid-fetch; retry next poll
      }

      // Walk back by parent hash until the branch joins a block we hold.
      let first = branch[0] as RpcBlockHeader;
      while (!this.#byHash.has(first.parentHash)) {
        if (first.number - 1 <= this.finalized.number) {
          throw new UnrecoverableReorgError(
            `chain ${pool.chainId}: block ${first.number} does not descend from finalised block ${this.finalized.number} (${this.finalized.hash})`,
          );
        }
        first = await pool.getBlockHeaderByHash(first.parentHash);
        branch.unshift(first);
      }
      const ancestor = this.#byHash.get(first.parentHash) as RpcBlockHeader;

      if (ancestor.hash !== tip.hash) {
        const keep = this.#chain.findIndex((h) => h.hash === ancestor.hash) + 1;
        const dropped = this.#chain.slice(keep);
        await this.#o.handle({ type: "reorg", ancestor, dropped });
        if (this.#rewoundPast(epoch, ancestor.number + 1)) return;
        this.#chain = this.#chain.slice(0, keep);
        for (const h of dropped) {
          this.#byHash.delete(h.hash);
          this.#data.delete(h.hash);
        }
        // Children announced on the dropped branch were never announced.
        for (const f of this.#factories ?? []) {
          for (const [address, created] of f.children)
            if (created > ancestor.number) f.children.delete(address);
        }
      }

      for (const header of branch) {
        const data = await this.#blockData(header);
        if (this.#rewoundPast(epoch, header.number)) return; // rewound while fetching: deliver again later
        await this.#o.handle({
          type: "block",
          block: { header, logs: data.logs, traces: data.traces, ticks: data.ticks },
        });
        if (this.#rewoundPast(epoch, header.number)) return; // rewound while it was handled: not kept
        this.#chain.push(header);
        this.#byHash.set(header.hash, header);
        this.#data.set(header.hash, data);
        for (const [i, f] of (this.#factories ?? []).entries()) {
          for (const log of data.parents[i] ?? []) {
            const address = childAddress(f.spec, log);
            if (address !== undefined && !f.children.has(address)) f.children.set(address, header.number);
          }
        }
      }
      if (target === head) return;
    }
  }

  #active(spec: SourceSpec, block: number): boolean {
    return spec.startBlock <= block && (spec.endBlock === undefined || block <= spec.endBlock);
  }

  async #loadFactories(): Promise<FactoryState[]> {
    if (this.#factories !== undefined) return this.#factories;
    const factories: FactoryState[] = [];
    for (const spec of this.#specs) {
      if (spec.kind !== "factoryLog") continue;
      const hash = factoryHash(spec.factory);
      if (factories.some((f) => f.hash === hash)) continue;
      const children = await this.#o.store.factoryChildren(this.#o.pool.chainId, hash, this.finalized.number);
      factories.push({ spec: spec.factory, hash, parent: factoryParentFilter(spec.factory), children });
    }
    this.#factories = factories;
    return factories;
  }

  /** Everything the sources need from one block, read by its hash. */
  async #blockData(header: RpcBlockHeader): Promise<BlockData> {
    const pool = this.#o.pool;
    const factories = await this.#loadFactories();
    const specs = this.#specs;
    const logs: RpcLog[][] = specs.map(() => []);
    const traces: RpcTrace[][] = specs.map(() => []);
    const ticks = specs.map(
      (spec) =>
        spec.kind === "block" &&
        this.#active(spec, header.number) &&
        intervalBlocks(spec, header.number, header.number).length === 1,
    );

    // Plain log sources and factory announcements, in one batch.
    const plain = specs.flatMap((spec, i) =>
      spec.kind === "log" && this.#active(spec, header.number) ? [{ i, filter: spec.filter }] : [],
    );
    const announcing = factories.filter((f) =>
      specs.some(
        (spec) =>
          spec.kind === "factoryLog" &&
          factoryHash(spec.factory) === f.hash &&
          this.#active(spec, header.number),
      ),
    );
    const first = await pool.getBlockLogs(header.hash, [
      ...plain.map((p) => p.filter),
      ...announcing.map((f) => f.parent),
    ]);
    plain.forEach((p, k) => {
      logs[p.i] = first[k] ?? [];
    });
    const parents = factories.map((f) => {
      const k = announcing.indexOf(f);
      return k < 0 ? [] : (first[plain.length + k] ?? []);
    });

    // Children announced in this block count from this block, so child logs are read after announcements.
    const childSources = specs.flatMap((spec, i) =>
      spec.kind === "factoryLog" && this.#active(spec, header.number) ? [{ i, spec }] : [],
    );
    if (childSources.length > 0) {
      const childMaps = childSources.map(({ spec }) => {
        const index = factories.findIndex((x) => x.hash === factoryHash(spec.factory));
        const f = factories[index];
        const children = new Map(f?.children ?? []);
        for (const log of parents[index] ?? []) {
          const address = f === undefined ? undefined : childAddress(f.spec, log);
          if (address !== undefined && !children.has(address)) children.set(address, header.number);
        }
        return children;
      });
      const filters = childSources.map(({ spec }, k) => {
        const children = childMaps[k] ?? new Map<string, number>();
        const byAddress = children.size > 0 && children.size <= (this.#o.maxAddressesPerFilter ?? 1_000);
        return normalizeLogFilter({
          chainId: pool.chainId,
          address: byAddress ? ([...children.keys()] as Hex[]) : null,
          topics: spec.topics,
        });
      });
      const fetched = await pool.getBlockLogs(header.hash, filters);
      childSources.forEach(({ i, spec }, k) => {
        const children = childMaps[k] ?? new Map<string, number>();
        logs[i] =
          children.size === 0
            ? []
            : (fetched[k] ?? []).filter((log) => factoryLogMatches(spec, children, log));
      });
    }

    // Traces: the whole block once, then each source's effective calls.
    const traceSources = specs.flatMap((spec, i) =>
      spec.kind === "trace" && this.#active(spec, header.number) ? [{ i, spec }] : [],
    );
    if (traceSources.length > 0) {
      const all = await pool.traceBlock(header);
      for (const { i, spec } of traceSources) {
        const to = new Set(spec.to.map((a) => a.toLowerCase()));
        const candidates = all.filter(
          (t) =>
            to.has(t.to.toLowerCase()) &&
            (spec.selectors === null || spec.selectors.includes(t.input.slice(0, 10).toLowerCase() as Hex)),
        );
        traces[i] = effectiveCalls(candidates, all);
      }
    }
    return { logs, traces, ticks, parents };
  }

  async #finalize(finalized: RpcBlockHeader): Promise<void> {
    const base = this.finalized;
    if (finalized.number <= base.number) return;
    // Finalise only what we hold, and only if it is the block we hold: otherwise our branch is
    // stale and the next poll will reorg onto the right one first.
    const index = this.#chain.findIndex((h) => h.number === finalized.number);
    if (index < 0 || this.#chain[index]?.hash !== finalized.hash) return;

    const newlyFinal = this.#chain.slice(1, index + 1);
    const chainId = this.#o.pool.chainId;
    const factories = await this.#loadFactories();
    // Every source, and each factory's announcing events, goes into the cache under its own key.
    const promotions: {
      spec: SourceSpec;
      pick: (hash: string) => { logs: readonly RpcLog[]; traces: readonly RpcTrace[] };
    }[] = [
      ...this.#specs.map((spec, i) => ({
        spec,
        pick: (hash: string) => {
          const d = this.#data.get(hash);
          return { logs: d?.logs[i] ?? [], traces: d?.traces[i] ?? [] };
        },
      })),
      ...factories.map((f, i) => ({
        spec: {
          kind: "log" as const,
          filter: f.parent,
          startBlock: Math.min(
            ...this.#specs
              .filter((s) => s.kind === "factoryLog" && factoryHash(s.factory) === f.hash)
              .map((s) => s.startBlock),
          ),
        },
        pick: (hash: string) => ({ logs: this.#data.get(hash)?.parents[i] ?? [], traces: [] }),
      })),
    ];
    for (const { spec, pick } of promotions) {
      const from = Math.max(base.number + 1, spec.startBlock);
      const to = Math.min(finalized.number, spec.endBlock ?? finalized.number);
      if (from > to) continue;
      const logs: RpcLog[] = [];
      const traces: RpcTrace[] = [];
      const headers: RpcBlockHeader[] = [];
      for (const header of newlyFinal) {
        if (header.number < from || header.number > to) continue;
        const picked = pick(header.hash);
        logs.push(...picked.logs);
        traces.push(...picked.traces);
        const tick = spec.kind === "block" && intervalBlocks(spec, header.number, header.number).length === 1;
        if (picked.logs.length > 0 || picked.traces.length > 0 || tick) headers.push(header);
      }
      await this.#o.store.commitSourceRange({
        chainId,
        sourceHash: sourceHash(spec),
        spec,
        fromBlock: from,
        toBlock: to,
        logs,
        traces,
        headers,
      });
    }
    for (const f of factories) {
      const children = [...f.children].filter(
        ([, created]) => created > base.number && created <= finalized.number,
      );
      await this.#o.store.addFactoryChildren(
        chainId,
        f.hash,
        children.map(([address, createdBlock]) => ({ address: address as Hex, createdBlock })),
      );
    }

    await this.#o.handle({ type: "finalize", header: finalized });
    for (const h of this.#chain.slice(0, index)) {
      this.#byHash.delete(h.hash);
      this.#data.delete(h.hash);
    }
    this.#chain = this.#chain.slice(index);
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof NotYetAvailableError) return true;
  const name = error instanceof Error ? error.name : "";
  return [
    "AllEndpointsFailedError",
    "LaggingNodeError",
    "TransportError",
    "InvalidResponseError",
    "RangeTooLargeError",
  ].includes(name);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
