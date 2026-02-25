import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;
export { postgres };

export interface ConnectOptions {
  max?: number;
  /** Shown in `pg_stat_activity`, so operators can tell Tidemark's connections apart. */
  applicationName?: string;
}

export function connect(url: string, options: ConnectOptions = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    onnotice: () => undefined,
    connection: { application_name: options.applicationName ?? "tidemark" },
    // bigint columns come back as JavaScript bigint, never as a lossy number.
    types: { bigint: postgres.BigInt },
  });
}

export interface Migration {
  /** Sorts lexically; apply order. Never renumber or edit a migration once released. */
  readonly id: string;
  readonly sql: string;
}

/**
 * Applies `migrations` for `namespace` that have not been applied yet, each in its own
 * transaction, under an advisory lock so concurrent processes cannot race. Refuses to run when the
 * database has a migration this code does not know, since that means an older binary is running
 * against a newer schema.
 */
export async function migrate(
  sql: Sql,
  namespace: string,
  migrations: readonly Migration[],
): Promise<string[]> {
  const ordered = [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    // One lock for every namespace: they all share the bookkeeping table below, and two concurrent
    // `create schema if not exists` race to a unique violation.
    await tx`select pg_advisory_xact_lock(${advisoryKey("migrate")})`;
    await tx.unsafe(`
      create schema if not exists tm_meta;
      create table if not exists tm_meta.migrations (
        namespace text not null,
        id text not null,
        checksum text not null,
        applied_at timestamptz not null default now(),
        primary key (namespace, id)
      );
    `);
    const rows = await tx<{ id: string; checksum: string }[]>`
      select id, checksum from tm_meta.migrations where namespace = ${namespace}
    `;
    const known = new Map(ordered.map((m) => [m.id, checksum(m.sql)]));
    for (const row of rows) {
      const expected = known.get(row.id);
      if (expected === undefined) {
        throw new Error(`database has ${namespace} migration ${row.id}, which this version does not know`);
      }
      if (expected !== row.checksum) {
        throw new Error(`${namespace} migration ${row.id} was edited after it was applied`);
      }
    }
    const done = new Set(rows.map((r) => r.id));
    for (const migration of ordered) {
      if (done.has(migration.id)) continue;
      await tx.unsafe(migration.sql);
      await tx`
        insert into tm_meta.migrations (namespace, id, checksum)
        values (${namespace}, ${migration.id}, ${checksum(migration.sql)})
      `;
      applied.push(migration.id);
    }
  });
  return applied;
}

function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A stable signed 64-bit advisory lock key for a name. */
export function advisoryKey(name: string): bigint {
  return createHash("sha256").update(name).digest().readBigInt64BE(0);
}

export function hexToBytes(hex: string): Buffer {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new RangeError(`not even-length hex: ${hex.slice(0, 20)}`);
  return Buffer.from(hex.slice(2), "hex");
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** Quotes an identifier for interpolation into SQL text. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Streams lines in COPY text format into a table. `target` is the already-quoted table name and
 * `columns` the already-quoted column list. Lines must end with a newline.
 */
export async function copyIn(
  sql: Sql | TransactionSql,
  target: string,
  columns: readonly string[],
  lines: Iterable<string>,
): Promise<void> {
  const stream = await sql.unsafe(`copy ${target} (${columns.join(", ")}) from stdin`).writable();
  const batched = function* () {
    let buffer = "";
    for (const line of lines) {
      buffer += line;
      if (buffer.length >= 1 << 16) {
        yield buffer;
        buffer = "";
      }
    }
    if (buffer !== "") yield buffer;
  };
  await pipeline(Readable.from(batched()), stream);
}
