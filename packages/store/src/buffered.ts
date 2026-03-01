import { metrics } from "@tidemark/core";
import { type Sql, type TransactionSql, copyIn, ident } from "@tidemark/pg";
import {
  type AnyTable,
  type Row,
  completeRow,
  fromDbRow,
  normalizePatch,
  primaryKeyOf,
  toCopyLine,
} from "@tidemark/schema";
import { RecordNotFoundError, type StoreBackend, UniqueConstraintError } from "./api.js";

const flushSeconds = metrics.histogram("tm_flush_seconds", "Store flush duration.", ["schema"]);
const flushRows = metrics.counter("tm_flush_rows_total", "Rows written by store flushes.", ["schema", "op"]);

interface Entry {
  /** The primary key values, normalised. */
  readonly key: Row;
  /** The row as handlers see it now, or null if it does not exist. */
  row: Row | null;
  /** Whether the row exists in the database as of the last flush. */
  persisted: boolean;
  /** Whether `row` differs from what the database holds. */
  dirty: boolean;
}

class TableCache {
  readonly entries = new Map<string, Entry>();
  /**
   * True while every row of the table is in `entries`, so a miss means the row does not exist and
   * no query is needed. Holds for a table that was empty when indexing started, until eviction.
   */
  complete: boolean;
  dirty = 0;

  constructor(complete: boolean) {
    this.complete = complete;
  }
}

export interface FlushStats {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

export interface BufferedStoreOptions {
  readonly sql: Sql;
  readonly schema: string;
  readonly tables: readonly AnyTable[];
  /** Clean rows kept in memory after a flush before eviction starts. */
  readonly maxCachedRows?: number;
  /**
   * Notify this channel (`tm_commit`, for live queries) in each flush transaction that changed
   * rows, with the schema and the tables changed. Listeners hear it when the flush commits.
   */
  readonly notify?: string;
  /**
   * History companions by table name (`historyTable` from @tidemark/schema). Writes to these tables
   * also record versions, bounded by the checkpoint set with `at`. Companions must be in `tables`.
   */
  readonly history?: ReadonlyMap<string, AnyTable>;
}

/** The channel live queries listen on. */
export const COMMIT_CHANNEL = "tm_commit";

export interface CommitNotice {
  readonly schema: string;
  readonly tables: readonly string[];
}

/** Sends a commit notice inside `tx`: delivered to listeners when it commits, never if it rolls back. */
export async function notifyCommit(
  tx: { unsafe: Sql["unsafe"] },
  channel: string,
  notice: CommitNotice,
): Promise<void> {
  await tx.unsafe("select pg_notify($1, $2)", [channel, JSON.stringify(notice)]);
}

/**
 * The store used below the finalised block. Reads are served from memory and fall through to
 * Postgres on a miss; writes stay in memory until `flush`, which writes them in one transaction:
 * deletes and updates through COPY into a temporary table, inserts with COPY straight into the
 * table. The caller adds its checkpoint to the same transaction, so after a crash the tables and
 * the checkpoint always agree.
 *
 * Nothing here is journaled: rows below the finalised block can never be reorged.
 */
export class BufferedStore implements StoreBackend {
  readonly #sql: Sql;
  readonly #schema: string;
  readonly #caches = new Map<string, TableCache>();
  readonly #tables: readonly AnyTable[];
  readonly #maxCachedRows: number;
  readonly #notify: string | undefined;
  readonly #history: ReadonlyMap<string, AnyTable>;
  /** Per history table: the open version's start checkpoint by row key ("" for none). */
  readonly #open = new Map<string, Map<string, string>>();
  #checkpoint: string | undefined;
  #reads = 0;

  private constructor(options: BufferedStoreOptions, complete: Map<string, boolean>) {
    this.#sql = options.sql;
    this.#schema = options.schema;
    this.#tables = options.tables;
    this.#maxCachedRows = options.maxCachedRows ?? 500_000;
    this.#notify = options.notify;
    this.#history = options.history ?? new Map();
    for (const table of options.tables)
      this.#caches.set(table.name, new TableCache(complete.get(table.name) ?? false));
  }

  /** Opens a store over existing tables. Empty tables start complete, so their misses cost nothing. */
  static async open(options: BufferedStoreOptions): Promise<BufferedStore> {
    const complete = new Map<string, boolean>();
    for (const table of options.tables) {
      const [row] = await options.sql.unsafe<{ empty: boolean }[]>(
        `select not exists (select 1 from ${ident(options.schema)}.${ident(table.name)}) as empty`,
      );
      complete.set(table.name, row?.empty ?? false);
    }
    return new BufferedStore(options, complete);
  }

  /** The checkpoint of the event about to write: versions of history tables start and end at it. */
  at(checkpoint: string): void {
    this.#checkpoint = checkpoint;
  }

  /** The start of the open version of a row of a history table, or "" when it has none. */
  async #openVersion(
    table: AnyTable,
    history: AnyTable,
    key: { values: Row; text: string },
  ): Promise<string> {
    let open = this.#open.get(table.name);
    if (open === undefined) {
      open = new Map();
      this.#open.set(table.name, open);
    }
    const known = open.get(key.text);
    if (known !== undefined) return known;
    let from = "";
    if (!this.#cache(history).complete) {
      this.#reads++;
      const where = table.primaryKey
        .map((k, i) => `${ident(table.columnList.find((c) => c.key === k)?.sqlName ?? k)} = $${i + 1}`)
        .join(" and ");
      const params = table.primaryKey.map((k) => {
        const c = table.columnList.find((col) => col.key === k);
        return c?.column.codec.toParam(key.values[k] as never);
      });
      const [row] = await this.#sql.unsafe<{ from: string }[]>(
        `select tm_valid_from as "from" from ${this.#qualified(history)} where ${where} and tm_valid_to is null`,
        params as never[],
      );
      from = row?.from ?? "";
    }
    open.set(key.text, from);
    return from;
  }

  /** After a write of `row` (null: deleted) to a history table: close the open version, open a new one. */
  async #version(table: AnyTable, key: { values: Row; text: string }, row: Row | null): Promise<void> {
    const history = this.#history.get(table.name);
    if (history === undefined) return;
    const at = this.#checkpoint;
    if (at === undefined)
      throw new Error(`${table.name} keeps history: the store needs a checkpoint (at) before writes`);
    const from = await this.#openVersion(table, history, key);
    if (from === at) {
      // A second write in the same event: edit that event's version.
      const entry = await this.#entry(history, primaryKeyOf(history, { ...key.values, tmValidFrom: at }));
      this.#setRow(history, entry, row === null ? null : { ...row, tmValidFrom: at, tmValidTo: null });
    } else {
      if (from !== "") {
        const previous = await this.#entry(
          history,
          primaryKeyOf(history, { ...key.values, tmValidFrom: from }),
        );
        if (previous.row !== null) this.#setRow(history, previous, { ...previous.row, tmValidTo: at });
      }
      if (row !== null) {
        const entry = await this.#entry(history, primaryKeyOf(history, { ...key.values, tmValidFrom: at }));
        this.#setRow(history, entry, { ...row, tmValidFrom: at, tmValidTo: null });
      }
    }
    this.#open.get(table.name)?.set(key.text, row === null ? "" : at);
  }

  /** Rows changed since the last flush. */
  get dirtyRows(): number {
    let n = 0;
    for (const cache of this.#caches.values()) n += cache.dirty;
    return n;
  }

  /** Database reads caused by cache misses, for metrics and tests. */
  get databaseReads(): number {
    return this.#reads;
  }

  #cache(table: AnyTable): TableCache {
    const cache = this.#caches.get(table.name);
    if (cache === undefined) throw new Error(`table ${table.name} is not part of this schema`);
    return cache;
  }

  #qualified(table: AnyTable): string {
    return `${ident(this.#schema)}.${ident(table.name)}`;
  }

  async #entry(table: AnyTable, key: { values: Row; text: string }): Promise<Entry> {
    const cache = this.#cache(table);
    const cached = cache.entries.get(key.text);
    if (cached !== undefined) return cached;
    if (cache.complete) {
      const entry: Entry = { key: key.values, row: null, persisted: false, dirty: false };
      cache.entries.set(key.text, entry);
      return entry;
    }
    this.#reads++;
    const where = table.primaryKey
      .map((k, i) => `${ident(table.columnList.find((c) => c.key === k)?.sqlName ?? k)} = $${i + 1}`)
      .join(" and ");
    const params = table.primaryKey.map((k) => {
      const c = table.columnList.find((col) => col.key === k);
      return c?.column.codec.toParam(key.values[k] as never);
    });
    const [dbRow] = await this.#sql.unsafe<Row[]>(
      `select * from ${this.#qualified(table)} where ${where}`,
      params as never[],
    );
    const row = dbRow === undefined ? null : fromDbRow(table, dbRow);
    const entry: Entry = { key: key.values, row, persisted: row !== null, dirty: false };
    cache.entries.set(key.text, entry);
    return entry;
  }

  #setRow(table: AnyTable, entry: Entry, row: Row | null): void {
    const cache = this.#cache(table);
    if (!entry.dirty) cache.dirty++;
    entry.row = row;
    entry.dirty = true;
  }

  async find(table: AnyTable, key: Row): Promise<Row | null> {
    const entry = await this.#entry(table, primaryKeyOf(table, key));
    return entry.row === null ? null : { ...entry.row };
  }

  async insert(
    table: AnyTable,
    input: Row,
    onConflict: "error" | "nothing" | { update: Row | ((existing: Row) => Row) },
  ): Promise<void> {
    const row = completeRow(table, input);
    const key = primaryKeyOf(table, Object.fromEntries(table.primaryKey.map((k) => [k, row[k]])));
    const entry = await this.#entry(table, key);
    if (entry.row !== null) {
      if (onConflict === "nothing") return;
      if (onConflict === "error") {
        throw new UniqueConstraintError(`${table.name}: a row with key ${key.text} already exists`);
      }
      const patch =
        typeof onConflict.update === "function" ? onConflict.update({ ...entry.row }) : onConflict.update;
      const updated = { ...entry.row, ...normalizePatch(table, patch) };
      this.#setRow(table, entry, updated);
      await this.#version(table, key, updated);
      return;
    }
    this.#setRow(table, entry, row);
    await this.#version(table, key, row);
  }

  async update(table: AnyTable, key: Row, patch: Row | ((existing: Row) => Row)): Promise<Row> {
    const pk = primaryKeyOf(table, key);
    const entry = await this.#entry(table, pk);
    if (entry.row === null)
      throw new RecordNotFoundError(`${table.name}: no row with key ${pk.text} to update`);
    const values = typeof patch === "function" ? patch({ ...entry.row }) : patch;
    const row = { ...entry.row, ...normalizePatch(table, values) };
    this.#setRow(table, entry, row);
    await this.#version(table, pk, row);
    return { ...row };
  }

  async delete(table: AnyTable, key: Row): Promise<boolean> {
    const pk = primaryKeyOf(table, key);
    const entry = await this.#entry(table, pk);
    if (entry.row === null) return false;
    this.#setRow(table, entry, null);
    await this.#version(table, pk, null);
    return true;
  }

  /**
   * Writes every change since the last flush in one transaction, runs `inTransaction` (the
   * caller's checkpoint) in the same transaction, and commits. On failure nothing is written and
   * the memory state is unchanged, so the caller can stop and resume from the last checkpoint.
   * `beforeWrites` runs first in the transaction (realtime uses it to switch journaling on).
   */
  async flush(
    inTransaction?: (tx: TransactionSql) => Promise<void>,
    beforeWrites?: (tx: TransactionSql) => Promise<void>,
  ): Promise<FlushStats> {
    const plan = this.#tables.map((table) => {
      const cache = this.#cache(table);
      const inserts: Row[] = [];
      const updates: Row[] = [];
      const deletes: Row[] = [];
      for (const entry of cache.entries.values()) {
        if (!entry.dirty) continue;
        if (entry.row === null) {
          // Deleted. A row that was never written needs nothing; the entry was only a negative cache.
          if (entry.persisted) deletes.push(entry.key);
        } else if (entry.persisted) updates.push(entry.row);
        else inserts.push(entry.row);
      }
      return { table, inserts, updates, deletes };
    });

    const flushStarted = performance.now();
    await this.#sql.begin(async (tx) => {
      await beforeWrites?.(tx);
      for (const { table, deletes } of plan)
        if (deletes.length > 0) await this.#flushDeletes(tx, table, deletes);
      for (const { table, updates } of plan)
        if (updates.length > 0) await this.#flushUpdates(tx, table, updates);
      for (const { table, inserts } of plan) {
        if (inserts.length === 0) continue;
        await copyIn(
          tx,
          this.#qualified(table),
          table.columnList.map((c) => ident(c.sqlName)),
          inserts.map((row) => toCopyLine(table, row)),
        );
      }
      await inTransaction?.(tx);
      if (this.#notify !== undefined) {
        const changed = plan
          .filter((p) => p.inserts.length + p.updates.length + p.deletes.length > 0)
          .map((p) => p.table.name);
        if (changed.length > 0)
          await notifyCommit(tx, this.#notify, { schema: this.#schema, tables: changed });
      }
    });

    // Committed: the database now matches memory.
    let total = 0;
    for (const cache of this.#caches.values()) {
      for (const entry of cache.entries.values()) {
        if (!entry.dirty) continue;
        entry.persisted = entry.row !== null;
        entry.dirty = false;
      }
      cache.dirty = 0;
      total += cache.entries.size;
    }
    if (total > this.#maxCachedRows) this.#evict();

    const stats = {
      inserted: plan.reduce((n, p) => n + p.inserts.length, 0),
      updated: plan.reduce((n, p) => n + p.updates.length, 0),
      deleted: plan.reduce((n, p) => n + p.deletes.length, 0),
    };
    flushSeconds.observe({ schema: this.#schema }, (performance.now() - flushStarted) / 1000);
    flushRows.inc({ schema: this.#schema, op: "insert" }, stats.inserted);
    flushRows.inc({ schema: this.#schema, op: "update" }, stats.updated);
    flushRows.inc({ schema: this.#schema, op: "delete" }, stats.deleted);
    return stats;
  }

  /**
   * Forgets everything cached. Call after the tables were changed behind the store's back (a reorg
   * rollback). Refuses while there are unflushed changes, which would be lost.
   */
  invalidate(): void {
    if (this.dirtyRows > 0) throw new Error("cannot invalidate a store with unflushed changes");
    this.#evict();
  }

  /** Drops every clean entry. The tables are no longer complete in memory, so misses query again. */
  #evict(): void {
    this.#open.clear();
    for (const cache of this.#caches.values()) {
      cache.entries.clear();
      cache.complete = false;
    }
  }

  async #tempTable(
    tx: TransactionSql,
    table: AnyTable,
    columns: readonly string[],
    kind: string,
  ): Promise<string> {
    const name = ident(`_tm_${kind}_${table.name}`);
    await tx.unsafe(
      `create temp table ${name} on commit drop as select ${columns.map(ident).join(", ")} from ${this.#qualified(table)} with no data`,
    );
    return name;
  }

  #keyColumns(table: AnyTable): string[] {
    return table.primaryKey.map((k) => table.columnList.find((c) => c.key === k)?.sqlName ?? k);
  }

  async #flushUpdates(tx: TransactionSql, table: AnyTable, rows: Row[]): Promise<void> {
    const keys = this.#keyColumns(table);
    const others = table.columnList.filter((c) => !table.primaryKey.includes(c.key));
    if (others.length === 0) return; // a table of keys only: an update changes nothing
    const temp = await this.#tempTable(
      tx,
      table,
      table.columnList.map((c) => c.sqlName),
      "update",
    );
    await copyIn(
      tx,
      temp,
      table.columnList.map((c) => ident(c.sqlName)),
      rows.map((row) => toCopyLine(table, row)),
    );
    await tx.unsafe(
      `update ${this.#qualified(table)} t set ${others.map((c) => `${ident(c.sqlName)} = u.${ident(c.sqlName)}`).join(", ")}
       from ${temp} u where ${keys.map((k) => `t.${ident(k)} = u.${ident(k)}`).join(" and ")}`,
    );
  }

  async #flushDeletes(tx: TransactionSql, table: AnyTable, keys: Row[]): Promise<void> {
    const keyColumns = table.columnList.filter((c) => table.primaryKey.includes(c.key));
    const temp = await this.#tempTable(
      tx,
      table,
      keyColumns.map((c) => c.sqlName),
      "delete",
    );
    const keyTable = { ...table, columnList: keyColumns };
    await copyIn(
      tx,
      temp,
      keyColumns.map((c) => ident(c.sqlName)),
      keys.map((key) => toCopyLine(keyTable, key)),
    );
    await tx.unsafe(
      `delete from ${this.#qualified(table)} t using ${temp} d
       where ${keyColumns.map((c) => `t.${ident(c.sqlName)} = d.${ident(c.sqlName)}`).join(" and ")}`,
    );
  }
}
