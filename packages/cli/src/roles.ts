import { type Sql, connect, ident } from "@tidemark/pg";
import { SyncStore } from "@tidemark/sync";
import { migrateMeta } from "@tidemark/engine";
import { migrateOutbox } from "@tidemark/outbox";

export interface RolesOptions {
  /** Role name prefix: `<prefix>_indexer` and `<prefix>_api`. Default "tm". */
  readonly prefix?: string;
  readonly indexerPassword: string;
  readonly apiPassword: string;
}

export interface RolesResult {
  readonly indexer: string;
  readonly api: string;
  /** Connection URLs for each role, from the admin URL with the user and password swapped. */
  readonly indexerUrl: string;
  readonly apiUrl: string;
}

const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * Least-privilege roles: the indexer owns everything it creates; the API can
 * read build schemas, live views and `tm_meta`, and nothing else, so even a query that escaped the
 * SQL guard could not write, or read the sync cache or the outbox. Run with an admin connection
 * (a superuser or a role with CREATEROLE). Idempotent: passwords are reset, grants re-applied.
 */
export async function initRoles(admin: Sql, adminUrl: string, options: RolesOptions): Promise<RolesResult> {
  const prefix = options.prefix ?? "tm";
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix))
    throw new Error(`role prefix "${prefix}" must be lowercase letters, digits and _`);
  if (options.indexerPassword.length < 12 || options.apiPassword.length < 12)
    throw new Error("role passwords need at least 12 characters");
  const indexer = `${prefix}_indexer`;
  const api = `${prefix}_api`;
  const [{ db } = { db: "" }] = await admin<{ db: string }[]>`select current_database() as db`;
  for (const [role, password] of [
    [indexer, options.indexerPassword],
    [api, options.apiPassword],
  ] as const) {
    const [exists] = await admin`select 1 from pg_roles where rolname = ${role}`;
    await admin.unsafe(
      `${exists === undefined ? "create" : "alter"} role ${ident(role)} with login password ${literal(password)}`,
    );
  }
  await admin.unsafe(`grant connect, create on database ${ident(db)} to ${ident(indexer)}`);
  await admin.unsafe(`grant connect on database ${ident(db)} to ${ident(api)}`);
  await admin.unsafe(`revoke create on schema public from ${ident(api)}`);
  // Whatever the indexer creates later (build schemas, live views, their tables) the API may read.
  await admin.unsafe(
    `alter default privileges for role ${ident(indexer)} grant usage on schemas to ${ident(api)}`,
  );
  await admin.unsafe(
    `alter default privileges for role ${ident(indexer)} grant select on tables to ${ident(api)}`,
  );

  const swap = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = encodeURIComponent(user);
    url.password = encodeURIComponent(password);
    return url.toString();
  };
  const indexerUrl = swap(indexer, options.indexerPassword);
  const apiUrl = swap(api, options.apiPassword);

  // Tidemark's own schemas, created by the indexer so it owns them; then the API loses the two it
  // has no business reading.
  const asIndexer = connect(indexerUrl, { max: 1 });
  try {
    await new SyncStore(asIndexer).migrate();
    await migrateMeta(asIndexer);
    await migrateOutbox(asIndexer);
  } finally {
    await asIndexer.end();
  }
  for (const schema of ["tm_sync", "tm_outbox"]) {
    await admin.unsafe(`revoke all on schema ${ident(schema)} from ${ident(api)}`);
    await admin.unsafe(`revoke all on all tables in schema ${ident(schema)} from ${ident(api)}`);
  }
  return { indexer, api, indexerUrl, apiUrl };
}
