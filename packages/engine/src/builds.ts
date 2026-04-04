import { createHash } from "node:crypto";
import { type Migration, type Sql, advisoryKey, ident, migrate } from "@tidemark/pg";
import { type SerializedSchema, relationsOf, serializeSchema, tableDdl, tablesOf } from "@tidemark/schema";
import type { Config } from "./config.js";

/**
 * Bumped whenever the engine changes what it writes for the same input, so every build id changes
 * and projects re-index (from the sync cache, without RPC) instead of mixing outputs.
 */
export const ENGINE_VERSION = "1.0.0";

export type BuildStatus = "indexing" | "ready" | "active" | "halted" | "retired";

export interface BuildRecord {
  readonly buildId: string;
  readonly schemaName: string;
  readonly status: BuildStatus;
  readonly createdAt: Date;
  readonly readyAt: Date | null;
  readonly activatedAt: Date | null;
  readonly error: string | null;
  readonly schema: SerializedSchema;
}

const metaMigrations: readonly Migration[] = [
  {
    id: "0001_builds",
    sql: `
      create table tm_meta.builds (
        build_id text primary key,
        schema_name text not null unique,
        status text not null,
        engine_version text not null,
        schema jsonb not null,
        created_at timestamptz not null default now(),
        ready_at timestamptz,
        activated_at timestamptz,
        retired_at timestamptz,
        error text
      );
      create table tm_meta.live_schemas (
        name text primary key,
        active_build text references tm_meta.builds (build_id),
        previous_build text references tm_meta.builds (build_id),
        views jsonb not null default '[]',
        history jsonb not null default '[]',
        updated_at timestamptz not null default now()
      );
    `,
  },
];

export const migrateMeta = (sql: Sql) => migrate(sql, "meta", metaMigrations);

/** What decides a build's output; RPC URLs and finality settings do not. */
function configForHash(config: Config): unknown {
  return {
    chains: Object.fromEntries(Object.entries(config.chains).map(([name, c]) => [name, { id: c.id }])),
    contracts: config.contracts,
    blocks: config.blocks ?? {},
    ordering: config.ordering ?? "per-chain",
  };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });

/**
 * A build's id: a hash of everything that can change what indexing writes. The engine version, the
 * config without RPC URLs or finality settings, the table and relation definitions, and the handler
 * code (the CLI's bundle, or the handlers' source text).
 */
export function computeBuildId(input: {
  config: Config;
  schema: Record<string, unknown>;
  code: string;
}): string {
  const tables = tablesOf(input.schema);
  return createHash("sha256")
    .update(
      stable([
        ENGINE_VERSION,
        configForHash(input.config),
        tables.flatMap((t) => tableDdl(t, "x")),
        serializeSchema(tables, relationsOf(input.schema)).relations,
        input.code,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

export const buildSchemaName = (buildId: string) => `tm_build_${buildId}`;

/** The handler source text, for a build id when there is no bundle. */
export const handlerCode = (handlers: ReadonlyMap<string, unknown>): string =>
  [...handlers]
    .map(([name, fn]) => `${name}=${String(fn)}`)
    .sort()
    .join("\n");

/** Records a build if it is new. Returns the stored record. */
export async function registerBuild(
  sql: Sql,
  buildId: string,
  schema: Record<string, unknown>,
): Promise<BuildRecord> {
  await migrateMeta(sql);
  const serialized = serializeSchema(tablesOf(schema), relationsOf(schema));
  await sql`
    insert into tm_meta.builds (build_id, schema_name, status, engine_version, schema)
    values (${buildId}, ${buildSchemaName(buildId)}, 'indexing', ${ENGINE_VERSION}, ${sql.json(serialized as never)})
    on conflict (build_id) do nothing
  `;
  const record = await getBuild(sql, buildId);
  if (record === undefined) throw new Error(`build ${buildId} vanished`);
  return record;
}

const toRecord = (r: Record<string, unknown>): BuildRecord => ({
  buildId: r.build_id as string,
  schemaName: r.schema_name as string,
  status: r.status as BuildStatus,
  createdAt: r.created_at as Date,
  readyAt: (r.ready_at as Date | null) ?? null,
  activatedAt: (r.activated_at as Date | null) ?? null,
  error: (r.error as string | null) ?? null,
  schema: r.schema as SerializedSchema,
});

export async function getBuild(sql: Sql, buildId: string): Promise<BuildRecord | undefined> {
  const [row] = await sql<
    Record<string, unknown>[]
  >`select * from tm_meta.builds where build_id = ${buildId}`;
  return row === undefined ? undefined : toRecord(row);
}

export async function listBuilds(sql: Sql): Promise<BuildRecord[]> {
  await migrateMeta(sql);
  const rows = await sql<Record<string, unknown>[]>`select * from tm_meta.builds order by created_at desc`;
  return rows.map(toRecord);
}

/** Marks a build ready (caught up) or halted (failed). Never demotes an active build. */
export async function setBuildStatus(
  sql: Sql,
  buildId: string,
  status: "ready" | "halted",
  error?: string,
): Promise<void> {
  await sql`
    update tm_meta.builds set
      status = case when status = 'active' then status else ${status} end,
      ready_at = case when ${status} = 'ready' and ready_at is null then now() else ready_at end,
      error = ${error ?? null}
    where build_id = ${buildId}
  `;
}

export interface LiveState {
  readonly name: string;
  readonly activeBuild: string | null;
  readonly previousBuild: string | null;
}

export async function liveState(sql: Sql, live: string): Promise<LiveState | undefined> {
  await migrateMeta(sql);
  const [row] = await sql<{ active_build: string | null; previous_build: string | null }[]>`
    select active_build, previous_build from tm_meta.live_schemas where name = ${live}
  `;
  return row === undefined
    ? undefined
    : { name: live, activeBuild: row.active_build, previousBuild: row.previous_build };
}

/** The build a live schema serves, with its table definitions. */
export async function activeBuild(sql: Sql, live: string): Promise<BuildRecord | undefined> {
  const state = await liveState(sql, live);
  return state?.activeBuild == null ? undefined : getBuild(sql, state.activeBuild);
}

export const CUTOVER_CHANNEL = "tidemark_cutover";

/**
 * Points a live schema at a build, in one transaction: its views are replaced by views of the
 * build's tables (and its checkpoints), the previous build is remembered for rollback, and
 * listeners on `tidemark_cutover` are notified. Refuses a build that is not ready unless `force`.
 */
export async function cutover(
  sql: Sql,
  live: string,
  buildId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(live) || live.startsWith("tm_") || live.startsWith("pg_")) {
    throw new Error(`"${live}" cannot be used as a live schema name`);
  }
  await migrateMeta(sql);
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${advisoryKey(`live:${live}`)})`;
    const [build] = await tx<
      Record<string, unknown>[]
    >`select * from tm_meta.builds where build_id = ${buildId} for update`;
    if (build === undefined) throw new Error(`no build ${buildId}`);
    const record = toRecord(build);
    if (options.force !== true && record.status !== "ready" && record.status !== "active") {
      throw new Error(`build ${buildId} is ${record.status}, not ready; wait for it, or force`);
    }
    await tx`insert into tm_meta.live_schemas (name) values (${live}) on conflict do nothing`;
    const [state] = await tx<{ active_build: string | null; views: string[] }[]>`
      select active_build, views from tm_meta.live_schemas where name = ${live} for update
    `;
    const s = ident(live);
    await tx.unsafe(`create schema if not exists ${s}`);
    for (const view of state?.views ?? []) await tx.unsafe(`drop view if exists ${s}.${ident(view)}`);
    const views = [...record.schema.tables.map((t) => t.name), "_tm_checkpoints"];
    for (const view of views) {
      await tx.unsafe(
        `create view ${s}.${ident(view)} as select * from ${ident(record.schemaName)}.${ident(view)}`,
      );
    }
    const previous = state?.active_build ?? null;
    await tx`
      update tm_meta.live_schemas set
        active_build = ${buildId},
        previous_build = case when ${previous}::text is distinct from ${buildId} then ${previous} else previous_build end,
        views = ${tx.json(views as never)},
        history = history || ${tx.json([{ buildId, at: new Date().toISOString() }] as never)},
        updated_at = now()
      where name = ${live}
    `;
    await tx`update tm_meta.builds set status = 'active', activated_at = now() where build_id = ${buildId}`;
    if (previous !== null && previous !== buildId) {
      await tx`update tm_meta.builds set status = 'ready' where build_id = ${previous} and status = 'active'`;
    }
    await tx`select pg_notify(${CUTOVER_CHANNEL}, ${live})`;
  });
}

/** Points a live schema back at the build it served before the last cutover. */
export async function rollback(sql: Sql, live: string): Promise<string> {
  const state = await liveState(sql, live);
  const previous = state?.previousBuild;
  if (previous == null) throw new Error(`live schema ${live} has no previous build`);
  await cutover(sql, live, previous, { force: true });
  return previous;
}

/**
 * Drops the schemas of builds that are neither active nor previous for any live schema, are not
 * being indexed, and were created before `olderThan`. Their records stay, marked retired.
 */
export async function pruneBuilds(sql: Sql, olderThan: Date): Promise<string[]> {
  await migrateMeta(sql);
  const rows = await sql<{ build_id: string; schema_name: string }[]>`
    select b.build_id, b.schema_name from tm_meta.builds b
    where b.status in ('ready', 'halted') and b.created_at < ${olderThan}
      and not exists (select 1 from tm_meta.live_schemas l where b.build_id in (l.active_build, l.previous_build))
  `;
  const dropped: string[] = [];
  for (const row of rows) {
    // A build whose indexer still holds its lock is running: leave it.
    const lock = await acquireBuildLock(sql, row.build_id, { wait: false });
    if (lock === undefined) continue;
    try {
      await sql.unsafe(`drop schema if exists ${ident(row.schema_name)} cascade`);
      await sql`update tm_meta.builds set status = 'retired', retired_at = now() where build_id = ${row.build_id}`;
      dropped.push(row.build_id);
    } finally {
      await lock.release();
    }
  }
  return dropped;
}

/**
 * The lock an indexer holds for as long as it runs a build, on a connection of its own (session
 * advisory locks belong to a connection). With `wait`, a second indexer for the same build blocks
 * here as a hot standby until the first stops; without, it gets undefined at once.
 */
export async function acquireBuildLock(
  sql: Sql,
  buildId: string,
  options: { wait: boolean; signal?: AbortSignal },
): Promise<{ release(): Promise<void> } | undefined> {
  const connection = await sql.reserve();
  const key = advisoryKey(`build:${buildId}`);
  try {
    if (options.wait) {
      for (;;) {
        const [row] = await connection<{ ok: boolean }[]>`select pg_try_advisory_lock(${key}) as ok`;
        if (row?.ok === true) break;
        if (options.signal?.aborted === true) {
          connection.release();
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } else {
      const [row] = await connection<{ ok: boolean }[]>`select pg_try_advisory_lock(${key}) as ok`;
      if (row?.ok !== true) {
        connection.release();
        return undefined;
      }
    }
  } catch (error) {
    connection.release();
    throw error;
  }
  return {
    async release() {
      try {
        await connection`select pg_advisory_unlock(${key})`;
      } finally {
        connection.release();
      }
    },
  };
}
