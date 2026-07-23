import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { type TestDatabase, createTestDatabase } from "./postgres.js";

/*
 * Every Tidemark package uses this one for its own tests, so it cannot import them statically
 * without a dependency cycle. It loads @tidemark/engine, @tidemark/pg and @tidemark/schema at run
 * time from the project under test, which has them installed.
 */

type Row = Record<string, unknown>;
interface TableLike {
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly columnList: readonly {
    readonly key: string;
    readonly sqlName: string;
    readonly column: {
      readonly codec: { normalize(v: unknown, where: string): unknown; toParam(v: never): unknown };
    };
  }[];
}
interface SqlLike {
  unsafe<T = Row[]>(query: string, params?: unknown[]): Promise<T>;
  end(): Promise<void>;
}
interface ProjectLike {
  readonly config: {
    readonly chains: Readonly<Record<string, { readonly rpc: string | readonly string[] }>>;
  };
  readonly handlers: ReadonlyMap<string, unknown>;
}

export interface IndexProjectOptions {
  /** The project: what `createTidemark` returned, with its handlers registered. */
  readonly tidemark: ProjectLike;
  /** The schema module: its tables (and relations). */
  readonly schema: Record<string, unknown>;
  /**
   * Keep following the chain after history, handling new blocks and reorgs, until `stop()`.
   * Without it, `indexProject` indexes up to the finalised block and returns.
   */
  readonly realtime?: boolean;
  /** Use this database instead of a fresh throwaway one. */
  readonly databaseUrl?: string;
  /** Postgres schema for the tables. Default "app". */
  readonly indexSchema?: string;
}

export interface IndexedProject {
  readonly sql: SqlLike;
  readonly indexSchema: string;
  /** Every row of a table, decoded as handlers see them (bigints, `0x` hex, Dates), in key order. */
  rows(table: TableLike): Promise<Row[]>;
  /** One row by primary key, or undefined. */
  find(table: TableLike, key: Row): Promise<Row | undefined>;
  /** With `realtime`: waits until the indexer has handled the chain's latest block. */
  caughtUp(timeoutMs?: number): Promise<void>;
  /** Stops the indexer and drops the throwaway database. */
  stop(): Promise<void>;
}

/** Loads a Tidemark package the way the project under test (the working directory) resolves it. */
async function load(specifier: string): Promise<Record<string, unknown>> {
  let target = specifier;
  try {
    target = pathToFileURL(createRequire(join(process.cwd(), "package.json")).resolve(specifier)).href;
  } catch {
    // Not resolvable from the working directory: fall back to this package's own resolution.
  }
  return (await import(target)) as Record<string, unknown>;
}

/**
 * Indexes a project against a test chain (Anvil, usually) into a throwaway database, for tests:
 *
 * ```ts
 * const indexed = await indexProject({ tidemark, schema, realtime: true });
 * await token.write.transfer([alice, 5n]);
 * await indexed.caughtUp();
 * expect(await indexed.find(account, { id: alice })).toMatchObject({ balance: 5n });
 * await anvil.reorg({ depth: 1 });
 * await indexed.caughtUp();
 * ```
 */
export async function indexProject(options: IndexProjectOptions): Promise<IndexedProject> {
  const [engine, pg, schemaPkg] = await Promise.all([
    load("@tidemark/engine"),
    load("@tidemark/pg"),
    load("@tidemark/schema"),
  ]);
  const runIndexer = engine.runIndexer as (o: Record<string, unknown>) => Promise<unknown>;
  const connect = pg.connect as (url: string, o: Record<string, unknown>) => SqlLike;
  const fromDbRow = schemaPkg.fromDbRow as (table: TableLike, row: Row) => Row;
  const sqlNameOf = schemaPkg.sqlNameOf as (table: TableLike, key: string) => string;

  let db: TestDatabase | undefined;
  const url = options.databaseUrl ?? (db = await createTestDatabase()).url;
  const sql = connect(url, { max: 6 });
  const indexSchema = options.indexSchema ?? "app";
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const controller = new AbortController();
  const tip = { hash: "" };

  const chain = Object.values(options.tidemark.config.chains)[0];
  if (chain === undefined) throw new Error("the project has no chains");
  const rpc = typeof chain.rpc === "string" ? chain.rpc : chain.rpc[0];
  const client = createPublicClient({ transport: http(rpc) });

  const run = runIndexer({
    tidemark: options.tidemark,
    schema: options.schema,
    sql,
    indexSchema,
    signal: controller.signal,
    ...(options.realtime === true
      ? {
          realtime: {
            pollIntervalMs: 20,
            onEvent: (event: {
              type: string;
              block?: { header: { hash: string } };
              ancestor?: { hash: string };
            }) => {
              if (event.type === "block" && event.block !== undefined) tip.hash = event.block.header.hash;
              else if (event.type === "reorg" && event.ancestor !== undefined) tip.hash = event.ancestor.hash;
            },
          },
        }
      : {}),
  });
  run.catch(() => undefined);
  if (options.realtime !== true) await run;

  const cleanup = async () => {
    await sql.end();
    await db?.drop();
  };

  return {
    sql,
    indexSchema,
    async rows(table) {
      const order = table.primaryKey.map((k) => quote(sqlNameOf(table, k))).join(", ");
      const rows = await sql.unsafe(
        `select * from ${quote(indexSchema)}.${quote(table.name)} order by ${order}`,
      );
      return rows.map((r) => fromDbRow(table, r));
    },
    async find(table, key) {
      const columns = table.primaryKey.map((k) => {
        const c = table.columnList.find((col) => col.key === k);
        if (c === undefined || key[k] === undefined)
          throw new TypeError(`${table.name}: key is missing "${k}"`);
        const value = c.column.codec.normalize(key[k], `${table.name}.${k}`);
        return { sqlName: c.sqlName, param: c.column.codec.toParam(value as never) };
      });
      const where = columns.map((c, i) => `${quote(c.sqlName)} = $${i + 1}`).join(" and ");
      const [row] = await sql.unsafe(
        `select * from ${quote(indexSchema)}.${quote(table.name)} where ${where}`,
        columns.map((c) => c.param),
      );
      return row === undefined ? undefined : fromDbRow(table, row);
    },
    async caughtUp(timeoutMs = 30_000) {
      if (options.realtime !== true) return;
      const deadline = Date.now() + timeoutMs;
      let failed: unknown;
      run.catch((error: unknown) => (failed = error));
      for (;;) {
        if (failed !== undefined)
          throw failed instanceof Error ? failed : new Error("indexer failed", { cause: failed });
        const head = await client.getBlock({ blockTag: "latest" });
        if (tip.hash === head.hash) return;
        if (Date.now() > deadline)
          throw new Error(`indexer did not reach block ${head.number} within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async stop() {
      controller.abort();
      try {
        await run;
      } finally {
        await cleanup();
      }
    },
  };
}
