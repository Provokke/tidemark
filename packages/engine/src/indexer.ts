import { createHash } from "node:crypto";
import { contiguousEnd, encodeCheckpoint, EventType, metrics } from "@tidemark/core";
import { type Sql, type TransactionSql, advisoryKey, ident } from "@tidemark/pg";
import {
  type Finality,
  LaggingNodeError,
  type RpcBlockHeader,
  RpcPool,
  type RpcReceipt,
  type RpcTransaction,
  type VerifyMode,
} from "@tidemark/rpc";
import { type AnyTable, historyTable, tableDdl, tablesOf } from "@tidemark/schema";
import {
  BufferedStore,
  COMMIT_CHANNEL,
  Db,
  enableJournal,
  notifyCommit,
  journalDdl,
  pruneJournal,
  rollbackJournalMany,
} from "@tidemark/store";
import {
  HistoricalSync,
  InconsistentChainDataError,
  type RealtimeBlock,
  type RealtimeEvent,
  RealtimeSync,
  SyncStore,
  intervalBlocks,
} from "@tidemark/sync";
import { ContextClients } from "./client.js";
import { blocksTable, historyFunctionsDdl } from "./history.js";
import { eventOutbox, outboxTable } from "./outbox.js";
import { type Config, type Hex, validateConfig } from "./config.js";
import {
  type ReadyEvent,
  type SourcePlan,
  UndecodableLogError,
  blockEvent,
  compareReady,
  decodeLog,
  decodeTrace,
  planSources,
} from "./plan.js";
import type { AnyHandler, HandlerContext, ReceiptInfo, TransactionInfo } from "./registry.js";

const eventsHandled = metrics.counter("tm_events_total", "Events handled, by chain and handler.", [
  "chain",
  "event",
]);
const handlerSeconds = metrics.histogram(
  "tm_handler_seconds",
  "Handler duration, by handler.",
  ["event"],
  [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
);
const boundHandlers = new Map<string, { events: { inc(): void }; seconds: { observe(v: number): void } }>();
/** Per-event metric handles, resolved once per chain and handler. */
function handlerMetrics(chain: string, event: string) {
  const key = `${chain}\u0000${event}`;
  let m = boundHandlers.get(key);
  if (m === undefined) {
    m = { events: eventsHandled.bind({ chain, event }), seconds: handlerSeconds.bind({ event }) };
    boundHandlers.set(key, m);
  }
  return m;
}
const processedBlock = metrics.gauge(
  "tm_processed_block",
  "The newest block whose events have all been handled.",
  ["chain"],
);
const finalizedBlock = metrics.gauge(
  "tm_finalized_block",
  "The chain's finalised block, as the indexer sees it.",
  ["chain"],
);
const headBlock = metrics.gauge("tm_head_block", "The chain's head, in realtime.", ["chain"]);
const realtimeLag = metrics.gauge(
  "tm_realtime_lag_blocks",
  "Head minus the newest handled block, in realtime.",
  ["chain"],
);
const reorgs = metrics.counter("tm_reorgs_total", "Reorgs rolled back.", ["chain"]);
const reorgDepth = metrics.histogram(
  "tm_reorg_depth_blocks",
  "Blocks rolled back per reorg.",
  ["chain"],
  [1, 2, 3, 5, 8, 13, 21, 34, 64, 128],
);

/** A handler threw. The build stops; the database stays at the last committed checkpoint. */
export class HandlerError extends Error {
  override name = "HandlerError";
  readonly eventName: string;
  readonly blockNumber: bigint;
  readonly transactionHash: string | undefined;

  constructor(ready: ReadyEvent, cause: unknown) {
    const e = ready.event;
    const where = ready.transactionHash === undefined ? "" : `, tx ${ready.transactionHash}`;
    super(
      `handler ${e.name} failed at block ${e.block.number}${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.eventName = e.name;
    this.blockNumber = e.block.number;
    this.transactionHash = ready.transactionHash;
  }
}

export interface ChainProgress {
  readonly chainId: number;
  readonly chainName: string;
  /** Every event at or below this block has been handled (not necessarily committed). */
  readonly processedBlock: number;
  readonly finalizedBlock: number;
  readonly events: number;
}

export interface ChainResult extends ChainProgress {
  /** False when every RPC endpoint was behind the finalised block and indexing stopped early. */
  readonly complete: boolean;
  /** The checkpoint of the last handled event. */
  readonly checkpoint: string;
}

export interface RunOptions {
  /** The project: its config and registered handlers (a `Tidemark` from `createTidemark`). */
  readonly tidemark: { readonly config: Config; readonly handlers: ReadonlyMap<string, AnyHandler> };
  /** The schema module: every exported `onchainTable`. */
  readonly schema: Record<string, unknown>;
  readonly sql: Sql;
  /** The Postgres schema that holds this project's tables. */
  readonly indexSchema: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ChainProgress) => void;
  /** Flush once this many rows are dirty. */
  readonly flushEveryRows?: number;
  /** Most blocks handled per batch; batches also shrink to keep about 5,000 events each. */
  readonly maxBatchBlocks?: number;
  /** Flush at least this often while indexing. */
  readonly flushIntervalMs?: number;
  /** Replaces the RPC pool for a chain; tests use it to inject proxies. */
  readonly createPool?: (chainName: string, chainId: number) => RpcPool;
  /** Called inside every flush transaction, after the rows and before the checkpoint. Tests use it to fail commits. */
  readonly beforeCommit?: (tx: TransactionSql) => Promise<void>;
}

export interface RunResult {
  readonly chains: readonly ChainResult[];
}

export interface RealtimeOptions {
  /** How often to poll each chain's head. */
  readonly pollIntervalMs?: number;
  /** Called after each realtime block, reorg and finality change is committed. */
  readonly onEvent?: (event: { readonly chainId: number } & RealtimeEvent) => void;
}

export interface IndexerOptions extends RunOptions {
  /** Follow every chain above its finalised block after historical indexing, until `signal` aborts. */
  readonly realtime?: RealtimeOptions;
  /**
   * Called once when indexing has caught up: every chain's history is indexed and, with
   * `realtime`, every chain has reached its head once.
   */
  readonly onReady?: () => void | Promise<void>;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates the project's tables and Tidemark's bookkeeping tables in `indexSchema`, or checks that
 * existing ones were created from the same table definitions. Resuming into tables made from a
 * different schema would mix incompatible data, so that is refused.
 */
export async function prepareIndexSchema(
  sql: Sql,
  indexSchema: string,
  tables: readonly AnyTable[],
): Promise<void> {
  const reserved =
    indexSchema.startsWith("pg_") || (indexSchema.startsWith("tm_") && !indexSchema.startsWith("tm_build_"));
  if (!SCHEMA_NAME.test(indexSchema) || reserved) {
    throw new Error(`"${indexSchema}" cannot be used as an index schema name`);
  }
  const ddl = tables.flatMap((table) => tableDdl(table, indexSchema));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(tables.flatMap((table) => tableDdl(table, "x"))))
    .digest("hex");
  const s = ident(indexSchema);
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${advisoryKey(`index-schema:${indexSchema}`)})`;
    await tx.unsafe(`create schema if not exists ${s}`);
    await tx.unsafe(`
      create table if not exists ${s}."_tm_meta" (key text primary key, value jsonb not null);
      create table if not exists ${s}."_tm_checkpoints" (
        chain_id bigint primary key,
        block_number bigint not null,
        checkpoint text collate "C" not null,
        -- Everything at or below finalized_block can never be reorged; the journal holds the rest.
        finalized_block bigint not null,
        finalized_checkpoint text collate "C" not null,
        updated_at timestamptz not null default now()
      );
    `);
    const [row] = await tx.unsafe<{ value: string }[]>(
      `select value #>> '{}' as value from ${s}."_tm_meta" where key = 'tables_fingerprint'`,
    );
    if (row === undefined) {
      for (const statement of ddl) await tx.unsafe(statement);
      for (const statement of journalDdl(indexSchema, tables)) await tx.unsafe(statement);
      for (const statement of historyFunctionsDdl(indexSchema, tables)) await tx.unsafe(statement);
      await tx.unsafe(
        `insert into ${s}."_tm_meta" (key, value) values ('tables_fingerprint', to_jsonb($1::text))`,
        [fingerprint],
      );
    } else if (row.value !== fingerprint) {
      throw new Error(
        `schema "${indexSchema}" was created from different table definitions; index into a new schema instead`,
      );
    }
  });
}

interface SavedCheckpoint {
  readonly blockNumber: number;
  readonly checkpoint: string;
}

/**
 * Loads each chain's checkpoint, first rolling back anything above its finalised block. Unfinalised
 * blocks indexed before a restart may have been reorged since; rather than remember the header
 * chain across restarts, Tidemark undoes them and follows the chain again from the finalised block.
 */
async function recoverCheckpoints(
  sql: Sql,
  indexSchema: string,
  tables: readonly AnyTable[],
): Promise<Map<number, SavedCheckpoint>> {
  const rows = await sql.unsafe<
    { chain_id: bigint; block_number: bigint; finalized_block: bigint; finalized_checkpoint: string }[]
  >(
    `select chain_id, block_number, finalized_block, finalized_checkpoint from ${ident(indexSchema)}."_tm_checkpoints"`,
  );
  const out = new Map<number, SavedCheckpoint>();
  const behind: { chainId: number; toBlock: number }[] = [];
  for (const r of rows) {
    const chainId = Number(r.chain_id);
    const finalized = Number(r.finalized_block);
    if (Number(r.block_number) > finalized) behind.push({ chainId, toBlock: finalized });
    out.set(chainId, { blockNumber: finalized, checkpoint: r.finalized_checkpoint });
  }
  // Every chain at once, in one journal pass: a row more than one chain changed must return to its
  // state before the oldest of those changes, which rolling chains back one by one gets wrong.
  if (behind.length > 0) {
    await sql.begin(async (tx) => {
      await rollbackJournalMany(tx, indexSchema, tables, behind);
      for (const { chainId } of behind) {
        await tx.unsafe(
          `update ${ident(indexSchema)}."_tm_checkpoints" set block_number = finalized_block,
             checkpoint = finalized_checkpoint, updated_at = now() where chain_id = $1`,
          [chainId],
        );
      }
      await notifyCommit(tx, COMMIT_CHANNEL, { schema: indexSchema, tables: tables.map((t) => t.name) });
    });
  }
  return out;
}

/** Serialises async work: realtime blocks from several chains share one store. */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/** Resolves on the next notification. */
class Signal {
  #waiters: (() => void)[] = [];
  notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }
  wait(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

const finalityOf = (finality: Config["chains"][string]["finality"]): Finality =>
  finality === undefined || finality === "tag" ? { kind: "tag" } : { kind: "depth", depth: finality.depth };

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const ZERO_CHECKPOINT_STRING = "0".repeat(75);

/** Everything about one chain the indexer needs while it runs. */
interface ChainRuntime {
  readonly name: string;
  readonly id: number;
  readonly pool: RpcPool;
  readonly finality: Finality;
  readonly maxLogRange: number | undefined;
  readonly strictTimestamps: boolean;
  readonly verify: VerifyMode | undefined;
  readonly sources: readonly SourcePlan[];
  readonly clients: ContextClients;
  readonly saved: SavedCheckpoint | undefined;
}

interface Shared {
  readonly options: IndexerOptions;
  readonly tables: readonly AnyTable[];
  readonly syncStore: SyncStore;
  readonly store: BufferedStore;
  readonly db: Db;
  /** Some table keeps history: record each block's timestamp, for time travel by block. */
  readonly keepsHistory: boolean;
}

const chainInfos = new WeakMap<ChainRuntime, { readonly id: number; readonly name: string }>();

/**
 * The context handlers get for an event. `client` is pinned to the event's block and built only if
 * the handler reads it, since most handlers do not.
 */
function contextFor(
  shared: Shared,
  chain: ChainRuntime,
  ready: ReadyEvent,
  finalized: boolean,
): HandlerContext {
  let info = chainInfos.get(chain);
  if (info === undefined) {
    info = { id: chain.id, name: chain.name };
    chainInfos.set(chain, info);
  }
  let client: HandlerContext["client"] | undefined;
  let outbox: HandlerContext["outbox"] | undefined;
  return {
    db: shared.db,
    chain: info,
    get outbox() {
      outbox ??= eventOutbox(shared.db, {
        chainId: chain.id,
        blockNumber: ready.event.block.number,
        blockHash: ready.event.block.hash,
        blockTimestamp: ready.event.block.timestamp,
        checkpoint: ready.event.checkpoint,
      });
      return outbox;
    },
    get client() {
      client ??= chain.clients.at({
        number: Number(ready.event.block.number),
        hash: ready.event.block.hash,
        finalized,
      });
      return client;
    },
  };
}

async function runHandler(
  shared: Shared,
  chain: ChainRuntime,
  ready: ReadyEvent,
  finalized: boolean,
): Promise<void> {
  try {
    shared.store.at(ready.event.checkpoint);
    if (shared.keepsHistory) {
      const { number, timestamp } = ready.event.block;
      await shared.db
        .insert(blocksTable)
        .values({ id: `${chain.id}:${number}`, chainId: BigInt(chain.id), blockNumber: number, timestamp })
        .onConflictDoNothing();
    }
    const started = performance.now();
    await ready.handler({
      event: ready.event as never,
      context: contextFor(shared, chain, ready, finalized),
    });
    const m = handlerMetrics(chain.name, ready.event.name);
    m.seconds.observe((performance.now() - started) / 1000);
    m.events.inc();
  } catch (error) {
    throw new HandlerError(ready, error);
  }
}

/** Adds the transaction and receipt to events whose source asked for them. */
function enrich(
  ready: ReadyEvent[],
  found: ReadonlyMap<string, { transaction: RpcTransaction; receipt: RpcReceipt }>,
): ReadyEvent[] {
  return ready.map((r) => {
    if (r.source.kind !== "log" && r.source.kind !== "factoryLog") return r;
    if (!r.source.includeTransaction && !r.source.includeReceipt) return r;
    const item = r.transactionHash === undefined ? undefined : found.get(r.transactionHash);
    if (item === undefined) return r;
    const t = item.transaction;
    const transaction: TransactionInfo = r.source.includeTransaction
      ? {
          hash: t.hash,
          index: t.transactionIndex,
          from: t.from,
          to: t.to,
          value: t.value,
          input: t.input,
          nonce: t.nonce,
          gas: t.gas,
          gasPrice: t.gasPrice,
          maxFeePerGas: t.maxFeePerGas,
          maxPriorityFeePerGas: t.maxPriorityFeePerGas,
          type: t.type,
        }
      : { hash: t.hash, index: t.transactionIndex };
    const receipt: ReceiptInfo | undefined = r.source.includeReceipt
      ? {
          status: item.receipt.status,
          gasUsed: item.receipt.gasUsed,
          cumulativeGasUsed: item.receipt.cumulativeGasUsed,
          effectiveGasPrice: item.receipt.effectiveGasPrice,
          contractAddress: item.receipt.contractAddress,
        }
      : undefined;
    return { ...r, event: { ...r.event, transaction, ...(receipt === undefined ? {} : { receipt }) } };
  });
}

const wantsTransaction = (r: ReadyEvent) =>
  (r.source.kind === "log" || r.source.kind === "factoryLog") &&
  (r.source.includeTransaction || r.source.includeReceipt) &&
  r.transactionHash !== undefined;

/** The events of one chain in a finalised block range, from the sync cache, in order and enriched. */
async function collectHistorical(
  shared: Shared,
  chain: ChainRuntime,
  from: number,
  to: number,
): Promise<ReadyEvent[]> {
  const out: ReadyEvent[] = [];
  const store = shared.syncStore;
  for (const source of chain.sources) {
    const start = Math.max(from, source.startBlock);
    const end = Math.min(to, source.endBlock ?? to);
    if (start > end) continue;
    const push = (make: () => ReadyEvent) => {
      try {
        out.push(make());
      } catch (error) {
        if (!(error instanceof UndecodableLogError)) throw error;
      }
    };
    if (source.kind === "log" && source.spec.kind === "log") {
      for (const log of await store.readLogs(source.spec.filter, start, end))
        push(() => decodeLog(source, log));
    } else if (source.kind === "factoryLog" && source.spec.kind === "factoryLog") {
      for (const log of await store.readFactoryLogs(source.spec, start, end))
        push(() => decodeLog(source, log));
    } else if (source.kind === "trace" && source.spec.kind === "trace") {
      for (const trace of await store.readTraces(source.spec, start, end))
        push(() => decodeTrace(source, trace));
    } else if (source.kind === "block" && source.spec.kind === "block") {
      const headers = await store.readBlocks(chain.id, intervalBlocks(source.spec, start, end));
      for (const header of headers) out.push(blockEvent(source, header));
    }
  }
  out.sort(compareReady);

  const hashes = [...new Set(out.filter(wantsTransaction).map((r) => r.transactionHash as Hex))];
  if (hashes.length === 0) return out;
  const found = new Map(await store.getTransactions(chain.id, hashes));
  const missing = hashes.filter((h) => !found.has(h));
  if (missing.length > 0) {
    const fetched = await chain.pool.getTransactions(missing);
    const blockOf = new Map(out.map((r) => [r.transactionHash, r.event.block.hash]));
    for (const item of fetched) {
      if (item.transaction.blockHash !== blockOf.get(item.transaction.hash)) {
        throw new InconsistentChainDataError(
          `transaction ${item.transaction.hash} is in a different block than its log`,
        );
      }
      found.set(item.transaction.hash, item);
    }
    await store.putTransactions(chain.id, fetched);
  }
  return enrich(out, found);
}

/** The events of one realtime block, read by block hash, in order and enriched. */
async function collectRealtime(chain: ChainRuntime, block: RealtimeBlock): Promise<ReadyEvent[]> {
  const header = block.header;
  const out: ReadyEvent[] = [];
  chain.sources.forEach((source, i) => {
    const push = (make: () => ReadyEvent) => {
      try {
        out.push(make());
      } catch (error) {
        if (!(error instanceof UndecodableLogError)) throw error;
      }
    };
    switch (source.kind) {
      case "log":
      case "factoryLog":
        for (const log of block.logs[i] ?? [])
          push(() => decodeLog(source, { ...log, blockTimestamp: header.timestamp }));
        break;
      case "trace":
        for (const trace of block.traces[i] ?? [])
          push(() => decodeTrace(source, { ...trace, blockTimestamp: header.timestamp }));
        break;
      case "block":
        if (block.ticks[i] === true) out.push(blockEvent(source, header));
        break;
    }
  });
  out.sort(compareReady);
  const hashes = [...new Set(out.filter(wantsTransaction).map((r) => r.transactionHash as Hex))];
  if (hashes.length === 0) return out;
  const fetched = await chain.pool.getTransactions(hashes);
  for (const item of fetched) {
    // Not cached: the block may still be reorged. A node on another branch counts as behind.
    if (item.transaction.blockHash !== header.hash) throw new LaggingNodeError(-1, header.number);
  }
  return enrich(out, new Map(fetched.map((f) => [f.transaction.hash, f])));
}

export async function runHistorical(options: RunOptions): Promise<RunResult> {
  return runIndexer(options);
}

/**
 * Indexes every chain up to its finalised block, then, with `realtime`, follows each chain above it:
 * one transaction per block with every change journaled, rolled back on a reorg, and the journal
 * pruned as blocks become final. With `ordering: "omnichain"`, events from every chain run in one
 * order by block timestamp, in both phases. Resolves when `signal` aborts.
 */
export async function runIndexer(options: IndexerOptions): Promise<RunResult> {
  const chains: ChainResult[] = [];
  try {
    return await run(options, chains);
  } catch (error) {
    // A stop the caller asked for is not a failure. Whatever was not committed is redone next run.
    if (options.signal?.aborted === true) return { chains };
    throw error;
  }
}

async function run(options: IndexerOptions, results: ChainResult[]): Promise<RunResult> {
  const config = options.tidemark.config;
  validateConfig(config);
  const plans = planSources(config, options.tidemark.handlers);
  // History companions, the outbox and the block index are journaled tables like the user's.
  const userTables = tablesOf(options.schema);
  const history = new Map(
    userTables.filter((t) => t.options.history === true).map((t) => [t.name, historyTable(t)]),
  );
  const tables = [
    ...userTables,
    ...history.values(),
    outboxTable,
    ...(history.size > 0 ? [blocksTable] : []),
  ];
  const syncStore = new SyncStore(options.sql);
  await syncStore.migrate();
  await prepareIndexSchema(options.sql, options.indexSchema, tables);

  const store = await BufferedStore.open({
    sql: options.sql,
    schema: options.indexSchema,
    tables,
    notify: COMMIT_CHANNEL,
    history,
  });
  const shared: Shared = {
    options,
    tables,
    syncStore,
    store,
    db: new Db(store),
    keepsHistory: history.size > 0,
  };
  const saved = await recoverCheckpoints(options.sql, options.indexSchema, tables);

  const chains: ChainRuntime[] = [];
  for (const [name, chain] of Object.entries(config.chains)) {
    const sources = plans.filter((p) => p.chainName === name);
    if (sources.length === 0) continue;
    const pool =
      options.createPool?.(name, chain.id) ??
      new RpcPool({ chainId: chain.id, endpoints: typeof chain.rpc === "string" ? [chain.rpc] : chain.rpc });
    await pool.probe();
    chains.push({
      name,
      id: chain.id,
      pool,
      finality: finalityOf(chain.finality),
      maxLogRange: chain.maxLogRange,
      strictTimestamps: chain.strictTimestamps === true,
      verify: chain.verify,
      sources,
      clients: new ContextClients(pool, syncStore),
      saved: saved.get(chain.id),
    });
  }

  if (config.ordering === "omnichain") {
    results.push(...(await indexOmnichainHistorical(shared, chains)));
  } else {
    for (const chain of chains) results.push(await indexChain(shared, chain));
  }

  const realtime = options.realtime;
  if (realtime === undefined) {
    if (results.every((r) => r.complete)) await options.onReady?.();
  } else {
    const follow = new Followers(shared, chains, results, realtime, config.ordering === "omnichain");
    await follow.run();
  }
  return { chains: results };
}

// ---------------------------------------------------------------- committing

async function commit(shared: Shared, chainId: number, block: number, checkpoint: string): Promise<void> {
  const { options, store } = shared;
  await store.flush(async (tx) => {
    await options.beforeCommit?.(tx);
    await writeHistoricalCheckpoint(tx, options.indexSchema, chainId, block, checkpoint);
  });
}

/** Historical blocks are all final: the finalised checkpoint moves with the checkpoint. */
async function writeHistoricalCheckpoint(
  tx: TransactionSql,
  indexSchema: string,
  chainId: number,
  block: number,
  checkpoint: string,
) {
  await tx.unsafe(
    `insert into ${ident(indexSchema)}."_tm_checkpoints" (chain_id, block_number, checkpoint, finalized_block, finalized_checkpoint)
     values ($1, $2, $3, $2, $3)
     on conflict (chain_id) do update set block_number = excluded.block_number,
       checkpoint = excluded.checkpoint, finalized_block = excluded.finalized_block,
       finalized_checkpoint = excluded.finalized_checkpoint, updated_at = now()`,
    [chainId, block, checkpoint],
  );
}

// ---------------------------------------------------------------- historical, per chain

/**
 * Syncs one chain's sources up to its finalised block and runs their handlers in chain order while
 * the sync is still filling the cache. Writes are committed with the chain's checkpoint, so a crash
 * at any point resumes from the last commit and reaches the same final state.
 */
async function indexChain(shared: Shared, chain: ChainRuntime): Promise<ChainResult> {
  const { options, syncStore, store } = shared;
  const sources = chain.sources;
  const finalized = (await chain.pool.finalizedBlock(chain.finality)).number;
  const firstBlock = Math.min(...sources.map((s) => s.startBlock));
  let processed = chain.saved?.blockNumber ?? firstBlock - 1;
  let checkpoint = chain.saved?.checkpoint ?? ZERO_CHECKPOINT_STRING;
  let events = 0;

  const cachedThrough = new Map<string, number>();
  for (const source of sources) {
    const cached = await syncStore.cachedIntervals(chain.id, source.hash);
    cachedThrough.set(source.hash, contiguousEnd(cached, source.startBlock));
  }

  const progress = new Signal();
  const syncAbort = new AbortController();
  const signal =
    options.signal === undefined ? syncAbort.signal : AbortSignal.any([options.signal, syncAbort.signal]);
  const syncState: { done: boolean; incomplete: boolean; error: unknown } = {
    done: false,
    incomplete: false,
    error: undefined,
  };
  const sync = new HistoricalSync({
    pool: chain.pool,
    store: syncStore,
    sources: sources.map((s) => s.spec),
    ...(chain.maxLogRange === undefined ? {} : { maxLogRange: chain.maxLogRange }),
    ...(chain.verify === undefined ? {} : { verify: chain.verify }),
    signal,
    onProgress: (p) => {
      cachedThrough.set(p.filterHash, Math.max(cachedThrough.get(p.filterHash) ?? -1, p.cachedThrough));
      progress.notify();
    },
  })
    .run(finalized)
    .then((report) => {
      syncState.incomplete = report.incomplete;
    })
    .catch((error: unknown) => {
      syncState.error = error;
    })
    .finally(() => {
      syncState.done = true;
      progress.notify();
    });

  /** The highest block below which every source is cached. */
  const safeBlock = () => {
    let safe = finalized;
    for (const s of sources) {
      const through = cachedThrough.get(s.hash) ?? s.startBlock - 1;
      const done = s.endBlock !== undefined && through >= s.endBlock;
      if (!done) safe = Math.min(safe, through);
    }
    return safe;
  };

  const flushEveryRows = options.flushEveryRows ?? 100_000;
  const flushIntervalMs = options.flushIntervalMs ?? 30_000;
  let lastFlush = Date.now();
  let committedBlock = processed;
  const commitNow = async () => {
    if (processed === committedBlock && store.dirtyRows === 0) return;
    await commit(shared, chain.id, processed, checkpoint);
    committedBlock = processed;
    lastFlush = Date.now();
  };

  const maxChunk = Math.max(1, options.maxBatchBlocks ?? 1_000_000);
  let chunk = Math.min(1_000, maxChunk);
  try {
    while (processed < finalized) {
      signal.throwIfAborted();
      const safe = safeBlock();
      if (safe <= processed) {
        if (syncState.done) {
          if (syncState.error !== undefined) throw asError(syncState.error);
          break; // every endpoint is behind: stop here, resume next run
        }
        await progress.wait();
        continue;
      }
      const end = Math.min(safe, processed + chunk);
      const batch = await collectHistorical(shared, chain, processed + 1, end);
      for (const ready of batch) {
        await runHandler(shared, chain, ready, true);
        checkpoint = ready.event.checkpoint;
      }
      events += batch.length;
      processed = end;
      chunk =
        batch.length > 10_000
          ? Math.max(1, Math.floor(chunk / 2))
          : batch.length < 2_500
            ? Math.min(chunk * 2, maxChunk)
            : chunk;
      processedBlock.set({ chain: chain.name }, processed);
      finalizedBlock.set({ chain: chain.name }, finalized);
      options.onProgress?.({
        chainId: chain.id,
        chainName: chain.name,
        processedBlock: processed,
        finalizedBlock: finalized,
        events,
      });
      if (store.dirtyRows >= flushEveryRows || Date.now() - lastFlush >= flushIntervalMs) await commitNow();
    }
    await commitNow();
  } finally {
    syncAbort.abort();
    await sync;
  }
  const syncError = syncState.error;
  if (syncError !== undefined && !(syncError instanceof Error && syncError.name === "AbortError"))
    throw asError(syncError);
  return {
    chainId: chain.id,
    chainName: chain.name,
    processedBlock: processed,
    finalizedBlock: finalized,
    events,
    checkpoint,
    complete: processed >= finalized && !syncState.incomplete,
  };
}

// ---------------------------------------------------------------- historical, omnichain

/**
 * Omnichain historical indexing: every chain is synced to its finalised block first, then events
 * from all chains are merged by checkpoint (block timestamp, then chain id, block, position).
 *
 * Each chain's committed block is the last block whose events have all run and none after it, so a
 * resume continues the same global order exactly.
 */
async function indexOmnichainHistorical(
  shared: Shared,
  chains: readonly ChainRuntime[],
): Promise<ChainResult[]> {
  const { options, store, syncStore } = shared;
  const signal = options.signal;
  const states = await Promise.all(
    chains.map(async (chain) => {
      const finalized = (await chain.pool.finalizedBlock(chain.finality)).number;
      const report = await new HistoricalSync({
        pool: chain.pool,
        store: syncStore,
        sources: chain.sources.map((s) => s.spec),
        ...(chain.maxLogRange === undefined ? {} : { maxLogRange: chain.maxLogRange }),
        ...(chain.verify === undefined ? {} : { verify: chain.verify }),
        ...(signal === undefined ? {} : { signal }),
      }).run(finalized);
      // Index only what every source has cached without a gap.
      let target = finalized;
      for (const s of chain.sources) {
        const through = contiguousEnd(await syncStore.cachedIntervals(chain.id, s.hash), s.startBlock);
        if (!(s.endBlock !== undefined && through >= s.endBlock)) target = Math.min(target, through);
      }
      const first = Math.min(...chain.sources.map((s) => s.startBlock));
      return {
        chain,
        finalized,
        target,
        incomplete: report.incomplete,
        processed: chain.saved?.blockNumber ?? first - 1,
        checkpoint: chain.saved?.checkpoint ?? ZERO_CHECKPOINT_STRING,
        buffer: [] as ReadyEvent[],
        loadedThrough: chain.saved?.blockNumber ?? first - 1,
        events: 0,
      };
    }),
  );

  const chunk = Math.max(1, Math.min(options.maxBatchBlocks ?? 1_000, 1_000));
  const flushEveryRows = options.flushEveryRows ?? 100_000;
  /** Fills a chain's buffer until it has an event or the chain is fully loaded. */
  const refill = async (s: (typeof states)[number]) => {
    while (s.buffer.length === 0 && s.loadedThrough < s.target) {
      signal?.throwIfAborted();
      const end = Math.min(s.target, s.loadedThrough + chunk);
      s.buffer = await collectHistorical(shared, s.chain, s.loadedThrough + 1, end);
      s.loadedThrough = end;
      if (s.buffer.length === 0) s.processed = end;
    }
  };
  /** A chain has handled everything up to just below its next pending event, or all it loaded. */
  const processedOf = (s: (typeof states)[number]) => {
    const next = s.buffer[0];
    return next === undefined ? s.loadedThrough : Number(next.event.block.number) - 1;
  };
  const commitAll = async () => {
    await store.flush(async (tx) => {
      await options.beforeCommit?.(tx);
      for (const s of states) {
        s.processed = Math.max(s.processed, processedOf(s));
        await writeHistoricalCheckpoint(tx, options.indexSchema, s.chain.id, s.processed, s.checkpoint);
      }
    });
  };

  for (;;) {
    for (const s of states) await refill(s);
    let next: (typeof states)[number] | undefined;
    for (const s of states) {
      const head = s.buffer[0];
      if (head === undefined) continue;
      const best = next?.buffer[0];
      if (best === undefined || compareReady(head, best) < 0) next = s;
    }
    if (next === undefined) break;
    const ready = next.buffer.shift() as ReadyEvent;
    await runHandler(shared, next.chain, ready, true);
    next.checkpoint = ready.event.checkpoint;
    next.events++;
    if (store.dirtyRows >= flushEveryRows) {
      await commitAll();
      for (const s of states) {
        processedBlock.set({ chain: s.chain.name }, s.processed);
        finalizedBlock.set({ chain: s.chain.name }, s.finalized);
        options.onProgress?.({
          chainId: s.chain.id,
          chainName: s.chain.name,
          processedBlock: s.processed,
          finalizedBlock: s.finalized,
          events: s.events,
        });
      }
    }
  }
  for (const s of states) s.processed = Math.max(s.processed, s.loadedThrough);
  await commitAll();
  return states.map((s) => ({
    chainId: s.chain.id,
    chainName: s.chain.name,
    processedBlock: s.processed,
    finalizedBlock: s.finalized,
    events: s.events,
    checkpoint: s.checkpoint,
    complete: s.processed >= s.finalized && !s.incomplete,
  }));
}

// ---------------------------------------------------------------- realtime

interface ProcessedBlock {
  readonly number: number;
  readonly timestamp: number;
  /** The checkpoint after this block's events. */
  readonly checkpoint: string;
}

interface Follower {
  readonly chain: ChainRuntime;
  sync: RealtimeSync | undefined;
  /** Blocks handled above the finalised block, oldest first; [0] is the finalised base. */
  processed: ProcessedBlock[];
  /** The newest head this chain has reported, and whether it has handled up to it. */
  head: RpcBlockHeader | undefined;
  /** In omnichain mode, the block waiting for its turn. */
  waiting: { block: RealtimeBlock; resolve: () => void; reject: (error: unknown) => void } | undefined;
}

/** The global order of blocks in omnichain mode. */
const blockKey = (timestamp: number, chainId: number, number: number) =>
  encodeCheckpoint({
    blockTimestamp: BigInt(timestamp),
    chainId: BigInt(chainId),
    blockNumber: BigInt(number),
    transactionIndex: 0n,
    eventType: EventType.transaction,
    eventIndex: 0n,
  });

/**
 * Follows every chain above its finalised block. Each block's events run and commit in one
 * transaction with journaling on; a reorg rolls the journal back to the common ancestor; a new
 * finalised block prunes the journal below it.
 *
 * In omnichain mode, a block runs only when no other chain can still produce a block that sorts
 * before it, and a reorg on one chain rolls every chain back to the same point in the global order,
 * then lets their followers deliver those blocks again.
 */
class Followers {
  readonly #shared: Shared;
  readonly #followers: Follower[];
  readonly #realtime: RealtimeOptions;
  readonly #omnichain: boolean;
  readonly #mutex = new Mutex();

  constructor(
    shared: Shared,
    chains: readonly ChainRuntime[],
    results: readonly ChainResult[],
    realtime: RealtimeOptions,
    omnichain: boolean,
  ) {
    this.#shared = shared;
    this.#realtime = realtime;
    this.#omnichain = omnichain;
    this.#followers = chains.map((chain) => {
      const result = results.find((r) => r.chainId === chain.id);
      return {
        chain,
        sync: undefined,
        processed: [
          {
            number: Math.max(0, result?.processedBlock ?? 0),
            timestamp: 0,
            checkpoint: result?.checkpoint ?? ZERO_CHECKPOINT_STRING,
          },
        ],
        head: undefined,
        waiting: undefined,
      };
    });
  }

  async run(): Promise<void> {
    const { options, syncStore } = this.#shared;
    await Promise.all(
      this.#followers.map(async (f) => {
        const base = await f.chain.pool.getBlockHeader(f.processed[0]?.number ?? 0);
        f.processed = [
          {
            number: base.number,
            timestamp: base.timestamp,
            checkpoint: f.processed[0]?.checkpoint ?? ZERO_CHECKPOINT_STRING,
          },
        ];
        f.sync = new RealtimeSync({
          pool: f.chain.pool,
          store: syncStore,
          sources: f.chain.sources.map((s) => s.spec),
          finality: f.chain.finality,
          base,
          ...(this.#realtime.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: this.#realtime.pollIntervalMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onHead: (head) => {
            f.head = head;
            headBlock.set({ chain: f.chain.name }, head.number);
            const tip = f.processed[f.processed.length - 1];
            if (tip !== undefined)
              realtimeLag.set({ chain: f.chain.name }, Math.max(0, head.number - tip.number));
            void this.#mutex
              .run(async () => {
                if (this.#omnichain) await this.#dispatch();
                await this.#checkReady();
              })
              .catch(() => undefined);
          },
          handle: (event) => this.#handle(f, event),
        });
      }),
    );
    // A stop releases blocks parked waiting for their omnichain turn; their followers then see the
    // signal and return.
    const release = () => {
      for (const f of this.#followers) {
        const parked = f.waiting;
        f.waiting = undefined;
        parked?.reject(new DOMException("stopped", "AbortError"));
      }
    };
    options.signal?.addEventListener("abort", release, { once: true });
    // A failure on one chain stops them all.
    const abort = new AbortController();
    try {
      await Promise.all(
        this.#followers.map(async (f) => {
          try {
            await f.sync?.run();
          } catch (error) {
            abort.abort();
            for (const other of this.#followers) other.waiting?.reject(error);
            throw error;
          }
        }),
      );
    } finally {
      abort.abort();
      options.signal?.removeEventListener("abort", release);
    }
  }

  #handle(f: Follower, event: RealtimeEvent): Promise<void> {
    if (event.type === "block" && this.#omnichain) {
      // Wait for this block's turn in the global order.
      return new Promise<void>((resolve, reject) => {
        if (this.#shared.options.signal?.aborted === true) {
          reject(new DOMException("stopped", "AbortError"));
          return;
        }
        f.waiting = { block: event.block, resolve, reject };
        void this.#mutex.run(() => this.#dispatch()).catch(reject);
      });
    }
    return this.#mutex.run(async () => {
      if (event.type === "block") await this.#applyBlock(f, event.block);
      else if (event.type === "reorg") await this.#reorg(f, event.ancestor);
      else await this.#finalize(f, event.header);
      this.#realtime.onEvent?.({ chainId: f.chain.id, ...event });
    });
  }

  /** Omnichain: run waiting blocks for as long as the earliest one cannot be preceded by anything. */
  async #dispatch(): Promise<void> {
    for (;;) {
      let next: Follower | undefined;
      let nextKey = "";
      for (const f of this.#followers) {
        if (f.waiting === undefined) continue;
        const h = f.waiting.block.header;
        const key = blockKey(h.timestamp, f.chain.id, h.number);
        if (next === undefined || key < nextKey) {
          next = f;
          nextKey = key;
        }
      }
      if (next?.waiting === undefined) return;
      // Every other chain must be unable to produce an earlier block: either it has one waiting
      // (which sorts later, or it would have been picked), or it has handled up to its head and
      // its next block cannot sort before this one. That next block is at least as late as the
      // head, and later still on a chain whose timestamps strictly increase.
      const blocked = this.#followers.some((f) => {
        if (f === next || f.waiting !== undefined) return false;
        const head = f.head;
        const tip = f.processed[f.processed.length - 1];
        if (head === undefined || tip === undefined || tip.number < head.number) return true;
        const earliest = head.timestamp + (f.chain.strictTimestamps ? 1 : 0);
        return blockKey(earliest, f.chain.id, head.number + 1) < nextKey;
      });
      if (blocked) return;
      const waiting = next.waiting;
      next.waiting = undefined;
      try {
        await this.#applyBlock(next, waiting.block);
        this.#realtime.onEvent?.({ chainId: next.chain.id, type: "block", block: waiting.block });
        waiting.resolve();
      } catch (error) {
        waiting.reject(error);
        throw error;
      }
    }
  }

  async #applyBlock(f: Follower, block: RealtimeBlock): Promise<void> {
    const { store, options } = this.#shared;
    const header = block.header;
    const batch = await collectRealtime(f.chain, block);
    let checkpoint = f.processed[f.processed.length - 1]?.checkpoint ?? ZERO_CHECKPOINT_STRING;
    for (const ready of batch) {
      await runHandler(this.#shared, f.chain, ready, false);
      checkpoint = ready.event.checkpoint;
    }
    await store.flush(
      async (tx) => {
        await options.beforeCommit?.(tx);
        await tx.unsafe(
          `update ${ident(options.indexSchema)}."_tm_checkpoints" set block_number = $2, checkpoint = $3, updated_at = now() where chain_id = $1`,
          [f.chain.id, header.number, checkpoint],
        );
      },
      (tx) => enableJournal(tx, f.chain.id, header.number),
    );
    f.processed.push({ number: header.number, timestamp: header.timestamp, checkpoint });
    processedBlock.set({ chain: f.chain.name }, header.number);
    if (f.head !== undefined)
      realtimeLag.set({ chain: f.chain.name }, Math.max(0, f.head.number - header.number));
    await this.#checkReady();
  }

  #ready = false;

  /** Fires `onReady` the first time every chain has handled up to its head. */
  async #checkReady(): Promise<void> {
    if (this.#ready) return;
    const caughtUp = this.#followers.every((f) => {
      const tip = f.processed[f.processed.length - 1];
      return f.head !== undefined && tip !== undefined && tip.number >= f.head.number;
    });
    if (!caughtUp) return;
    this.#ready = true;
    await this.#shared.options.onReady?.();
  }

  /**
   * Rolls chains back, each to its block, in one transaction: journal, checkpoints, and the record of
   * handled blocks. Several chains go back together in one journal pass, so a row more than one of
   * them changed returns to its state before the oldest change.
   */
  async #rollback(targets: readonly { follower: Follower; toBlock: number }[]): Promise<void> {
    const { options, tables, store } = this.#shared;
    const restored = targets.map(({ follower, toBlock }) => {
      const keep = follower.processed.filter((p) => p.number <= toBlock);
      return { follower, toBlock, keep: keep.length > 0 ? keep : follower.processed.slice(0, 1) };
    });
    await options.sql.begin(async (tx) => {
      await rollbackJournalMany(
        tx,
        options.indexSchema,
        tables,
        restored.map((r) => ({ chainId: r.follower.chain.id, toBlock: r.toBlock })),
      );
      await notifyCommit(tx, COMMIT_CHANNEL, {
        schema: options.indexSchema,
        tables: tables.map((t) => t.name),
      });
      for (const r of restored) {
        const last = r.keep[r.keep.length - 1];
        await tx.unsafe(
          `update ${ident(options.indexSchema)}."_tm_checkpoints" set block_number = $2, checkpoint = $3, updated_at = now() where chain_id = $1`,
          [r.follower.chain.id, last?.number ?? r.toBlock, last?.checkpoint ?? ZERO_CHECKPOINT_STRING],
        );
      }
    });
    store.invalidate();
    for (const r of restored) r.follower.processed = r.keep;
  }

  async #reorg(f: Follower, ancestor: RpcBlockHeader): Promise<void> {
    const tip = f.processed[f.processed.length - 1];
    reorgs.inc({ chain: f.chain.name });
    if (tip !== undefined)
      reorgDepth.observe({ chain: f.chain.name }, Math.max(0, tip.number - ancestor.number));
    if (!this.#omnichain) {
      await this.#rollback([{ follower: f, toBlock: ancestor.number }]);
      return;
    }
    // Every other chain's blocks that sort after the ancestor ran after blocks that no longer exist:
    // undo them together with the reorged chain's, and have their followers deliver them again.
    const cut = blockKey(ancestor.timestamp, f.chain.id, ancestor.number);
    const targets: { follower: Follower; toBlock: number }[] = [{ follower: f, toBlock: ancestor.number }];
    for (const other of this.#followers) {
      if (other === f) continue;
      const keep = other.processed.filter(
        (p, i) => i === 0 || blockKey(p.timestamp, other.chain.id, p.number) <= cut,
      );
      const to = keep[keep.length - 1]?.number;
      if (to === undefined || keep.length === other.processed.length) continue;
      targets.push({ follower: other, toBlock: to });
    }
    await this.#rollback(targets);
    for (const { follower, toBlock } of targets) {
      if (follower === f) continue;
      follower.sync?.rewind(toBlock);
      if (follower.waiting !== undefined) {
        follower.waiting.resolve(); // not applied: the follower sees the rewind and delivers it again
        follower.waiting = undefined;
      }
    }
  }

  async #finalize(f: Follower, header: RpcBlockHeader): Promise<void> {
    const { options, tables } = this.#shared;
    const final = header.number;
    const point = f.processed.find((p) => p.number === final) ?? f.processed[0];
    await options.sql.begin(async (tx) => {
      await pruneJournal(tx, options.indexSchema, tables, f.chain.id, final);
      await tx.unsafe(
        `update ${ident(options.indexSchema)}."_tm_checkpoints" set finalized_block = $2, finalized_checkpoint = $3, updated_at = now()
         where chain_id = $1`,
        [f.chain.id, final, point?.checkpoint ?? ZERO_CHECKPOINT_STRING],
      );
    });
    f.processed = f.processed.filter((p) => p.number >= final);
    if (f.processed.length === 0 || f.processed[0]?.number !== final) {
      f.processed.unshift({
        number: final,
        timestamp: header.timestamp,
        checkpoint: point?.checkpoint ?? ZERO_CHECKPOINT_STRING,
      });
    }
  }
}
