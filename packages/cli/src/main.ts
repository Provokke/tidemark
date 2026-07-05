import { existsSync, watch } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLiveApi, serveApp } from "@tidemark/api";
import { PROMETHEUS_CONTENT_TYPE, metrics } from "@tidemark/core";
import {
  type ChainProgress,
  computeBuildId,
  cutover,
  listBuilds,
  liveState,
  migrateMeta,
  pruneBuilds,
  rollback,
  runBuild,
} from "@tidemark/engine";
import { type Sql, connect } from "@tidemark/pg";
import { type DispatchEvent, listDeliveries, redrive, runOutboxDispatcher } from "@tidemark/outbox";
import { RpcPool } from "@tidemark/rpc";
import { SyncStore, exportCache, importCache, storageFor, verifyCache } from "@tidemark/sync";
import { codegen } from "./codegen.js";
import { initRoles } from "./roles.js";
import { type LoadedProject, ProjectError, loadProject, projectPaths } from "./project.js";

const USAGE = `Usage: tidemark <command> [options]

Commands:
  dev                 Index and serve the project, rebuilding on every change (hot reload)
  start               Index the current build; with --serve, also serve the API
  serve               Serve the API for the live schema (no indexing)
  deploy              Index the current build and make it live as soon as it is ready
  build               Bundle the project and print its build id
  promote <build>     Point the live schema at a build
  rollback            Point the live schema back at the build it served before
  builds list         List builds
  builds prune        Drop the schemas of old builds that are neither live nor the rollback target
  codegen             Write tidemark-env.d.ts and generated/schema.graphql
  db migrate          Create or upgrade Tidemark's own tables
  db init             Create least-privilege roles: <prefix>_indexer owns everything, <prefix>_api
                      only reads (passwords from TIDEMARK_INDEXER_PASSWORD, TIDEMARK_API_PASSWORD)
  cache stats         Show what the sync cache holds
  cache export <to>   Write the sync cache to a directory or s3://bucket/prefix (--chain to limit)
  cache import <from> Seed this database's sync cache from an export
  verify              Re-check cached logs against block headers (--chain, --from, --to,
                      --mode bloom|receipts-root, --repair to forget bad blocks)
  outbox list         List outbox deliveries (--status pending|delivered|dead)
  outbox redrive      Queue dead deliveries again (all, or --id <id> ...)

Options:
  --root <dir>            Project directory (default: the working directory)
  --database-url <url>    Postgres URL (default: $DATABASE_URL)
  --live <name>           Live schema the API serves (default: live)
  --port <n>              API port (default: $PORT or 42069)
  --host <addr>           API address (default: 127.0.0.1; 0.0.0.0 in containers)
  --serve                 With start: also serve the API
  --exit-when-live        With deploy: exit once the build is live (a one-off deploy task)
  --force                 With promote: promote a build that is not ready
  --older-than <dur>      With builds prune: e.g. 7d, 12h (default: 7d)
  --status <status>       With outbox list: pending, delivered or dead
  --id <id>               With outbox redrive: only these outbox ids (repeatable)
  --chain <name|id>       With verify and cache export: the chain
  --from <n>, --to <n>    With verify: the block range (default: everything cached)
  --mode <mode>           With verify: bloom (default) or receipts-root
  --repair                With verify: forget bad blocks so the next run fetches them again
  --s3-endpoint <url>     For s3:// paths: an S3-compatible endpoint (default: AWS, or $AWS_ENDPOINT_URL_S3)
  --metrics-port <n>      Serve Prometheus metrics on this port (/metrics), for processes without --serve
  --json                  Machine-readable output
  -h, --help              Show this help
`;

/** Something to print to the user: messages on stderr, data on stdout. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export class UsageError extends Error {
  override name = "UsageError";
}

interface Options {
  readonly root: string;
  readonly databaseUrl: string | undefined;
  readonly live: string;
  readonly port: number;
  readonly host: string;
  readonly serve: boolean;
  readonly force: boolean;
  readonly olderThan: string;
  readonly json: boolean;
  readonly status: string | undefined;
  readonly ids: readonly string[] | undefined;
  readonly chain: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly mode: string | undefined;
  readonly repair: boolean;
  readonly s3Endpoint: string | undefined;
  readonly metricsPort: number | undefined;
  readonly exitWhenLive: boolean;
}

function parseDuration(text: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (match === null) throw new UsageError(`bad duration "${text}": use e.g. 30m, 12h, 7d`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  return Number(match[1]) * unit;
}

/**
 * A URL from libpq's environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE,
 * PGSSLMODE), when DATABASE_URL is not set: how ECS injects a database secret.
 */
function urlFromPgEnv(): string | undefined {
  const host = process.env.PGHOST;
  if (host === undefined) return undefined;
  const user = encodeURIComponent(process.env.PGUSER ?? "postgres");
  const password =
    process.env.PGPASSWORD === undefined ? "" : `:${encodeURIComponent(process.env.PGPASSWORD)}`;
  const port = process.env.PGPORT ?? "5432";
  const database = encodeURIComponent(process.env.PGDATABASE ?? "postgres");
  const sslmode =
    process.env.PGSSLMODE === undefined ? "" : `?sslmode=${encodeURIComponent(process.env.PGSSLMODE)}`;
  return `postgres://${user}${password}@${host}:${port}/${database}${sslmode}`;
}

/** Loads `.env` files the way most tools do: `.env.local` overrides `.env`; the environment wins. */
function loadEnv(root: string): void {
  for (const file of [".env.local", ".env"]) {
    const path = join(root, file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

/**
 * Runs one CLI command. Resolves with the exit code; long-running commands (dev, start, serve,
 * deploy) resolve when `signal` aborts (SIGINT or SIGTERM in the binary).
 */
export async function main(
  argv: readonly string[],
  options: { signal?: AbortSignal; io?: Io } = {},
): Promise<number> {
  const io = options.io ?? defaultIo;
  const signal = options.signal ?? new AbortController().signal;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        root: { type: "string" },
        "database-url": { type: "string" },
        live: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        serve: { type: "boolean" },
        force: { type: "boolean" },
        "older-than": { type: "string" },
        json: { type: "boolean" },
        status: { type: "string" },
        chain: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        mode: { type: "string" },
        repair: { type: "boolean" },
        "s3-endpoint": { type: "string" },
        "metrics-port": { type: "string" },
        "exit-when-live": { type: "boolean" },
        id: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true || positionals.length === 0) {
    io.out(USAGE);
    return positionals.length === 0 && values.help !== true ? 2 : 0;
  }
  const root = resolve(values.root ?? process.cwd());
  loadEnv(root);
  const opts: Options = {
    root,
    databaseUrl: values["database-url"] ?? process.env.DATABASE_URL ?? urlFromPgEnv(),
    live: values.live ?? "live",
    port: Number(values.port ?? process.env.PORT ?? 42069),
    host: values.host ?? process.env.HOST ?? "127.0.0.1",
    serve: values.serve === true,
    force: values.force === true,
    olderThan: values["older-than"] ?? "7d",
    json: values.json === true,
    status: values.status,
    ids: values.id,
    chain: values.chain,
    from: values.from,
    to: values.to,
    mode: values.mode,
    repair: values.repair === true,
    s3Endpoint: values["s3-endpoint"] ?? process.env.AWS_ENDPOINT_URL_S3 ?? process.env.AWS_ENDPOINT_URL,
    exitWhenLive: values["exit-when-live"] === true,
    metricsPort:
      values["metrics-port"] !== undefined || process.env.METRICS_PORT !== undefined
        ? Number(values["metrics-port"] ?? process.env.METRICS_PORT)
        : undefined,
  };
  const [command, sub, ...rest] = positionals;
  try {
    switch (command) {
      case "dev":
        return await dev(opts, io, signal);
      case "start":
        return await start(opts, io, signal, "if-none", opts.serve);
      case "deploy":
        return await start(opts, io, signal, "when-ready", opts.serve);
      case "serve":
        return await serveOnly(opts, io, signal);
      case "build":
        return await buildId(opts, io);
      case "codegen": {
        const project = await loadProject(root);
        const { written } = await codegen(project.paths, project.schema);
        for (const file of written) io.err(`wrote ${relative(root, file)}`);
        if (written.length === 0) io.err("generated files are up to date");
        return 0;
      }
      case "promote": {
        if (sub === undefined) throw new UsageError("promote needs a build id (see `tidemark builds list`)");
        return await withSql(opts, async (sql) => {
          await cutover(sql, opts.live, sub, { force: opts.force });
          io.err(`${opts.live} now serves build ${sub}`);
          return 0;
        });
      }
      case "rollback":
        return await withSql(opts, async (sql) => {
          const to = await rollback(sql, opts.live);
          io.err(`${opts.live} rolled back to build ${to}`);
          return 0;
        });
      case "builds":
        if (sub === "list") return await withSql(opts, (sql) => buildsList(sql, opts, io));
        if (sub === "prune") {
          return await withSql(opts, async (sql) => {
            const dropped = await pruneBuilds(sql, new Date(Date.now() - parseDuration(opts.olderThan)));
            if (opts.json) io.out(JSON.stringify(dropped));
            else io.err(dropped.length === 0 ? "nothing to prune" : `dropped ${dropped.join(", ")}`);
            return 0;
          });
        }
        throw new UsageError(`unknown command: builds ${sub ?? ""}`);
      case "db":
        if (sub === "migrate") {
          return await withSql(opts, async (sql) => {
            await new SyncStore(sql).migrate();
            await migrateMeta(sql);
            io.err("database is up to date");
            return 0;
          });
        }
        if (sub === "init") {
          return await withSql(opts, async (sql) => {
            const indexerPassword = process.env.TIDEMARK_INDEXER_PASSWORD;
            const apiPassword = process.env.TIDEMARK_API_PASSWORD;
            if (indexerPassword === undefined || apiPassword === undefined) {
              throw new UsageError("db init needs TIDEMARK_INDEXER_PASSWORD and TIDEMARK_API_PASSWORD");
            }
            const roles = await initRoles(sql, opts.databaseUrl as string, {
              indexerPassword,
              apiPassword,
              ...(process.env.TIDEMARK_ROLE_PREFIX === undefined
                ? {}
                : { prefix: process.env.TIDEMARK_ROLE_PREFIX }),
            });
            io.err(
              `roles ${roles.indexer} (indexer: start, deploy, migrate) and ${roles.api} (serve: read-only) are ready`,
            );
            return 0;
          });
        }
        throw new UsageError(`unknown command: db ${sub ?? ""}`);
      case "outbox":
        if (sub === "list") {
          return await withSql(opts, async (sql) => {
            const status = opts.status;
            if (status !== undefined && !["pending", "delivered", "dead"].includes(status)) {
              throw new UsageError("--status is pending, delivered or dead");
            }
            const rows = await listDeliveries(sql, {
              live: opts.live,
              ...(status === undefined ? {} : { status: status as "pending" | "delivered" | "dead" }),
            });
            if (opts.json) io.out(JSON.stringify(rows));
            else if (rows.length === 0) io.err("no deliveries");
            else {
              for (const r of rows) {
                io.out(
                  `${r.id}  ${r.kind.padEnd(10)}  ${r.topic}  -> ${r.destination}  ${r.status} after ${r.attempts} attempt(s)${r.lastError === null ? "" : `  last error: ${r.lastError}`}`,
                );
              }
            }
            return 0;
          });
        }
        if (sub === "redrive") {
          return await withSql(opts, async (sql) => {
            const count = await redrive(sql, {
              live: opts.live,
              ...(opts.ids === undefined ? {} : { ids: opts.ids }),
            });
            io.err(count === 0 ? "nothing to redrive" : `queued ${count} dead deliveries again`);
            return 0;
          });
        }
        throw new UsageError(`unknown command: outbox ${sub ?? ""}`);
      case "verify":
        return await verifyCommand(opts, io);
      case "cache":
        if (sub === "stats") return await withSql(opts, (sql) => cacheStats(sql, opts, io));
        if (sub === "export" || sub === "import") {
          const target = rest[0];
          if (target === undefined)
            throw new UsageError(`cache ${sub} needs a directory or s3://bucket/prefix`);
          const storage = storageFor(target, {
            region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
            ...(opts.s3Endpoint === undefined ? {} : { endpoint: opts.s3Endpoint }),
          });
          return await withSql(opts, async (sql) => {
            const store = new SyncStore(sql);
            const onPart = (key: string, rows: number) => {
              io.err(`${sub === "export" ? "wrote" : "read"} ${storage.describe(key)} (${rows} rows)`);
            };
            if (sub === "export") {
              const chains = opts.chain === undefined ? undefined : [await chainIdOf(opts, opts.chain)];
              const manifest = await exportCache(store, storage, {
                ...(chains === undefined ? {} : { chains }),
                onPart,
              });
              io.err(
                `exported chains ${manifest.chains.join(", ") || "(none)"} to ${storage.describe("manifest.json")}`,
              );
            } else {
              const manifest = await importCache(store, storage, { onPart });
              io.err(`imported chains ${manifest.chains.join(", ")} from an export of ${manifest.createdAt}`);
            }
            return 0;
          });
        }
        throw new UsageError(`unknown command: cache ${sub ?? ""}`);
      default:
        throw new UsageError(`unknown command: ${[command, sub, ...rest].join(" ")}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof ProjectError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    io.err(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}

async function withSql<T>(opts: Options, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (opts.databaseUrl === undefined) {
    throw new UsageError("no database: set DATABASE_URL or pass --database-url");
  }
  const sql = connect(opts.databaseUrl, { max: 10 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A chain id from `--chain`: a number, or a chain name from the project's config. */
async function chainIdOf(opts: Options, chain: string): Promise<number> {
  if (/^\d+$/.test(chain)) return Number(chain);
  const project = await loadProject(opts.root);
  const config = project.config.chains[chain];
  if (config === undefined) throw new UsageError(`no chain named ${chain} in the config`);
  return config.id;
}

async function verifyCommand(opts: Options, io: Io): Promise<number> {
  if (opts.chain === undefined) throw new UsageError("verify needs --chain");
  const mode = opts.mode ?? "bloom";
  if (mode !== "bloom" && mode !== "receipts-root") throw new UsageError("--mode is bloom or receipts-root");
  const project = await loadProject(opts.root);
  const entry = Object.entries(project.config.chains).find(
    ([name, c]) => name === opts.chain || String(c.id) === opts.chain,
  );
  if (entry === undefined) throw new UsageError(`no chain ${opts.chain} in the config`);
  const [, chain] = entry;
  const pool = new RpcPool({
    chainId: chain.id,
    endpoints: typeof chain.rpc === "string" ? [chain.rpc] : chain.rpc,
  });
  return withSql(opts, async (sql) => {
    const store = new SyncStore(sql);
    await store.migrate();
    const from = opts.from === undefined ? 0 : Number(opts.from);
    const to = opts.to === undefined ? Number.MAX_SAFE_INTEGER : Number(opts.to);
    const checks = await verifyCache(store, pool, {
      chainId: chain.id,
      from,
      to,
      mode,
      repair: opts.repair,
      onProgress: (c) => {
        io.err(
          `${c.filterHash}: ${c.blocksChecked} blocks, ${c.badBlocks.length === 0 ? "all good" : `bad: ${c.badBlocks.join(", ")}`}`,
        );
      },
    });
    const bad = checks.flatMap((c) => c.badBlocks);
    if (opts.json) io.out(JSON.stringify(checks));
    if (bad.length === 0) {
      io.err(`verified ${checks.length} cached log filters with ${mode}: no differences`);
      return 0;
    }
    io.err(
      `${bad.length} block(s) differ from what their headers prove${opts.repair ? "; forgotten, the next run fetches them again" : "; run with --repair to forget them"}`,
    );
    return 1;
  });
}

async function buildId(opts: Options, io: Io): Promise<number> {
  const project = await loadProject(opts.root);
  const id = computeBuildId({ config: project.config, schema: project.schema, code: project.code });
  io.out(opts.json ? JSON.stringify({ buildId: id, bundle: project.bundleHash }) : id);
  return 0;
}

async function buildsList(sql: Sql, opts: Options, io: Io): Promise<number> {
  const [builds, state] = await Promise.all([listBuilds(sql), liveState(sql, opts.live)]);
  if (opts.json) {
    io.out(JSON.stringify({ live: state ?? null, builds }));
    return 0;
  }
  if (builds.length === 0) {
    io.err("no builds");
    return 0;
  }
  for (const b of builds) {
    const marks = [
      b.buildId === state?.activeBuild ? "live" : "",
      b.buildId === state?.previousBuild ? "previous" : "",
    ]
      .filter(Boolean)
      .join(", ");
    io.out(
      `${b.buildId}  ${b.status.padEnd(8)}  ${b.createdAt.toISOString()}  ${b.schema.tables.length} tables${marks === "" ? "" : `  (${marks})`}${b.error === null ? "" : `  error: ${b.error}`}`,
    );
  }
  return 0;
}

async function cacheStats(sql: Sql, opts: Options, io: Io): Promise<number> {
  await new SyncStore(sql).migrate();
  const rows = await sql<
    { chain_id: bigint; sources: number; blocks: string | null; logs: string; headers: string }[]
  >`
    select i.chain_id, count(*)::int as sources,
      sum((select sum(upper(r) - lower(r)) from unnest(i.blocks) r))::text as blocks,
      (select count(*) from tm_sync.logs l where l.chain_id = i.chain_id)::text as logs,
      (select count(*) from tm_sync.blocks b where b.chain_id = i.chain_id)::text as headers
    from tm_sync.intervals i group by i.chain_id order by i.chain_id
  `;
  const stats = rows.map((r) => ({
    chainId: Number(r.chain_id),
    sources: r.sources,
    blockRanges: Number(r.blocks ?? 0),
    logs: Number(r.logs),
    headers: Number(r.headers),
  }));
  if (opts.json) io.out(JSON.stringify(stats));
  else if (stats.length === 0) io.err("the sync cache is empty");
  else {
    for (const s of stats) {
      io.out(
        `chain ${s.chainId}: ${s.sources} sources, ${s.blockRanges} source-blocks synced, ${s.logs} logs, ${s.headers} headers`,
      );
    }
  }
  return 0;
}

async function serveOnly(opts: Options, io: Io, signal: AbortSignal): Promise<number> {
  return withSql(opts, async (sql) => {
    await migrateMeta(sql);
    const api = await createLiveApi({ sql, live: opts.live, ...apiAuth() });
    const server = await serveApp(api.app, opts.port, opts.host, { live: api.live, ...apiAuth() });
    io.err(`API on ${server.url} (live schema "${opts.live}", build ${api.buildId() ?? "none yet"})`);
    await untilAborted(signal);
    await server.close();
    await api.close();
    return 0;
  });
}

/**
 * Runs the outbox dispatcher for the live schema while `signal` is not aborted, if the project
 * configures destinations. One process per live schema delivers; others wait as standbys.
 */
function startDispatcher(
  sql: Sql,
  project: LoadedProject,
  opts: Options,
  io: Io,
  signal: AbortSignal,
): Promise<void> {
  const config = project.config.outbox;
  if (config === undefined) return Promise.resolve();
  const log = (e: DispatchEvent) => {
    if (e.type === "failed")
      io.err(
        `outbox: ${e.destination} ${e.kind} ${e.id} failed (attempt ${e.attempt}${e.dead ? ", dead" : ""}): ${e.error}`,
      );
  };
  return runOutboxDispatcher({ sql, config, live: opts.live, signal, onEvent: log }).catch(
    (error: unknown) => {
      io.err(`outbox dispatcher stopped: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

/** API keys from the environment: SHA-256 hex digests, comma-separated. */
function apiAuth(): { apiKeyHashes?: string[]; publicMetrics?: boolean } {
  const hashes = process.env.TIDEMARK_API_KEY_HASHES?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  // TIDEMARK_PUBLIC_METRICS=true: /metrics without a key, for a scraper on a private network.
  const publicMetrics = process.env.TIDEMARK_PUBLIC_METRICS === "true" ? { publicMetrics: true } : {};
  return hashes === undefined || hashes.length === 0
    ? publicMetrics
    : { apiKeyHashes: hashes, ...publicMetrics };
}

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });

/** Prints progress at most once a second per chain. */
function progressPrinter(io: Io, label: string): (p: ChainProgress) => void {
  const last = new Map<number, number>();
  return (p) => {
    const now = Date.now();
    if (now - (last.get(p.chainId) ?? 0) < 1_000) return;
    last.set(p.chainId, now);
    io.err(
      `[${label}] ${p.chainName}: block ${p.processedBlock} (finalized ${p.finalizedBlock}), ${p.events} events`,
    );
  };
}

/** A bare `/metrics` endpoint, for an indexer process that serves no API. */
async function serveMetrics(port: number, host: string, io: Io): Promise<{ close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    metrics
      .render()
      .then((text) => res.writeHead(200, { "content-type": PROMETHEUS_CONTENT_TYPE }).end(text))
      .catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  io.err(`metrics on http://${address.address}:${address.port}/metrics`);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function start(
  opts: Options,
  io: Io,
  signal: AbortSignal,
  promote: "if-none" | "when-ready",
  serve: boolean,
): Promise<number> {
  const project = await loadProject(opts.root);
  return withSql(opts, async (sql) => {
    let server: Awaited<ReturnType<typeof serveApp>> | undefined;
    let api: Awaited<ReturnType<typeof createLiveApi>> | undefined;
    if (serve) {
      await migrateMeta(sql);
      api = await createLiveApi({ sql, live: opts.live, ...apiAuth() });
      server = await serveApp(api.app, opts.port, opts.host, { live: api.live, ...apiAuth() });
      io.err(`API on ${server.url}`);
    }
    const metricsServer =
      !serve && opts.metricsPort !== undefined
        ? await serveMetrics(opts.metricsPort, opts.host, io)
        : undefined;
    // A one-off deploy stops once its build is live; the service then rolls onto it.
    const run = new AbortController();
    signal.addEventListener(
      "abort",
      () => {
        run.abort();
      },
      { once: true },
    );
    const state = { wentLive: false };
    const onLive = opts.exitWhenLive
      ? () => {
          state.wentLive = true;
          run.abort();
        }
      : undefined;
    const dispatching = opts.exitWhenLive
      ? Promise.resolve()
      : startDispatcher(sql, project, opts, io, signal);
    try {
      const result = await runProjectBuild(sql, project, opts, io, run.signal, promote, onLive);
      if (opts.exitWhenLive && !state.wentLive) {
        io.err(`build ${result.buildId} stopped before it went live`);
        return 1;
      }
      io.err(`stopped build ${result.buildId}`);
      return 0;
    } finally {
      await dispatching;
      await metricsServer?.close();
      await server?.close();
      await api?.close();
    }
  });
}

function runProjectBuild(
  sql: Sql,
  project: LoadedProject,
  opts: Options,
  io: Io,
  signal: AbortSignal,
  promote: "if-none" | "when-ready" | "never",
  onLive?: () => void,
) {
  let label = "build";
  return runBuild({
    tidemark: project.tidemark,
    schema: project.schema,
    sql,
    signal,
    code: project.code,
    live: opts.live,
    promote,
    realtime: {},
    onProgress: (p) => {
      progressPrinter(io, label)(p);
    },
    onBuild: ({ buildId, status }) => {
      label = buildId.slice(0, 8);
      if (status === "indexing") io.err(`build ${buildId}: indexing`);
      else if (status === "ready") io.err(`build ${buildId}: ready`);
      else {
        io.err(`build ${buildId}: live on "${opts.live}"`);
        onLive?.();
      }
    },
  });
}

/**
 * Development: indexes the project, serves the API, and on every change to the project's files
 * bundles again. A change that alters the build id starts a new build, which re-indexes from the
 * sync cache (no RPC for history) and replaces the old one when it has caught up; the API keeps
 * serving the old one until then. A bundle that fails to compile, or a build whose handlers throw,
 * leaves the running build in place.
 */
async function dev(opts: Options, io: Io, signal: AbortSignal): Promise<number> {
  const paths = projectPaths(opts.root);
  return withSql(opts, async (sql) => {
    await new SyncStore(sql).migrate();
    await migrateMeta(sql);
    const api = await createLiveApi({ sql, live: opts.live, pollIntervalMs: 500, ...apiAuth() });
    const server = await serveApp(api.app, opts.port, opts.host, { live: api.live, ...apiAuth() });
    io.err(`API on ${server.url} — POST /graphql, POST /sql, GET /status`);

    interface Running {
      readonly buildId: string;
      readonly controller: AbortController;
      readonly done: Promise<unknown>;
    }
    let current: Running | undefined;
    let pending: Running | undefined;
    let outbox: { key: string; controller: AbortController; done: Promise<void> } | undefined;
    const restartDispatcher = async (project: LoadedProject) => {
      const key = JSON.stringify(project.config.outbox ?? null, (_k, v: unknown) =>
        typeof v === "function" ? String(v) : v,
      );
      if (outbox?.key === key) return;
      outbox?.controller.abort();
      await outbox?.done;
      const controller = new AbortController();
      signal.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true },
      );
      outbox = { key, controller, done: startDispatcher(sql, project, opts, io, controller.signal) };
    };
    const stopRun = async (run: Running | undefined) => {
      if (run === undefined) return;
      run.controller.abort();
      await run.done.catch(() => undefined);
    };

    const reload = async () => {
      let project: LoadedProject;
      try {
        project = await loadProject(opts.root);
      } catch (error) {
        io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
        io.err("keeping the running build; fix the error and save again");
        return;
      }
      await restartDispatcher(project);
      await codegen(project.paths, project.schema).catch((error: unknown) => {
        io.err(`codegen failed: ${String(error)}`);
      });
      const buildId = computeBuildId({ config: project.config, schema: project.schema, code: project.code });
      if (buildId === (pending ?? current)?.buildId) return;
      await stopRun(pending);
      const controller = new AbortController();
      const onAbort = () => {
        controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const run: Running = {
        buildId,
        controller,
        done: runProjectBuild(sql, project, opts, io, controller.signal, "when-ready")
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              io.err(
                `build ${buildId} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
              );
              if (current !== undefined) io.err(`still serving build ${current.buildId}`);
            }
          })
          .finally(() => {
            signal.removeEventListener("abort", onAbort);
          }),
      };
      pending = run;
      // Replace the old build once the new one is live.
      void (async () => {
        while (!controller.signal.aborted && (await liveState(sql, opts.live))?.activeBuild !== buildId) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (controller.signal.aborted || pending !== run) return;
        const old = current;
        current = run;
        pending = undefined;
        await stopRun(old);
        await pruneBuilds(sql, new Date()).catch(() => undefined);
      })().catch((error: unknown) => {
        io.err(String(error));
      });
    };

    await reload();
    let timer: NodeJS.Timeout | undefined;
    let reloading = Promise.resolve();
    const ignored = /(^|[/\\])(node_modules|\.tidemark|\.git|generated|dist)([/\\]|$)|tidemark-env\.d\.ts$/;
    const watcher = watch(paths.root, { recursive: true }, (_event, file) => {
      if (file === null || ignored.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        io.err(`changed: ${file}`);
        reloading = reloading.then(reload);
      }, 150);
    });
    await untilAborted(signal);
    watcher.close();
    clearTimeout(timer);
    await reloading;
    await stopRun(pending);
    await stopRun(current);
    outbox?.controller.abort();
    await outbox?.done;
    await server.close();
    await api.close();
    return 0;
  });
}
