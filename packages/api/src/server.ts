import { PROMETHEUS_CONTENT_TYPE, metrics } from "@tidemark/core";
import { createHash } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { type Sql, ident } from "@tidemark/pg";
import { type SerializedSchema, deserializeSchema } from "@tidemark/schema";
import { GraphQLError, type GraphQLSchema } from "graphql";
import { type Context, Hono } from "hono";
import { routePath } from "hono/route";
import { streamSSE } from "hono/streaming";
import {
  type Outcome,
  type Target,
  isOutcome,
  makeTarget,
  prepareGraphQL,
  prepareSql,
  validationRules,
} from "./execute.js";
import type { GraphQLLimits } from "./graphql.js";
import { type LiveSpec, LiveLimitError, LiveQueries } from "./live.js";
import { attachWebSocket } from "./ws.js";

const apiRequests = metrics.counter("tm_api_requests_total", "API requests, by route and status.", [
  "route",
  "status",
]);
const apiSeconds = metrics.histogram("tm_api_request_seconds", "API request latency, by route.", ["route"]);
const liveQueries = metrics.gauge("tm_live_queries", "Live queries open.");

export interface ApiOptions {
  readonly sql: Sql;
  /** The schema module: tables and relations. */
  readonly schema: Record<string, unknown>;
  /** The Postgres schema queries read from. */
  readonly databaseSchema: string;
  readonly limits?: Partial<ApiLimits>;
  /** SHA-256 hex digests of accepted API keys. Omit to leave the API open. */
  readonly apiKeyHashes?: readonly string[];
  /** GraphQL introspection; on by default. */
  readonly introspection?: boolean;
  readonly cors?: boolean;
  /** Serve `/metrics` without an API key (for a scraper on a private network). Default false. */
  readonly publicMetrics?: boolean;
}

export interface ApiLimits extends GraphQLLimits {
  readonly maxDepth: number;
  readonly maxCost: number;
  readonly statementTimeoutMs: number;
  readonly sqlMaxRows: number;
  readonly maxBodyBytes: number;
  /** Requests per second per API key (or per address when the API is open). 0 means unlimited. */
  readonly requestsPerSecond: number;
  /** Live queries open at once, across every transport. */
  readonly maxLiveQueries: number;
  /** Longest a long-poll request is held. */
  readonly longPollMs: number;
}

export const defaultLimits: ApiLimits = {
  defaultPageSize: 100,
  maxPageSize: 1_000,
  maxDepth: 10,
  maxCost: 100_000,
  statementTimeoutMs: 5_000,
  sqlMaxRows: 10_000,
  maxBodyBytes: 256 * 1024,
  requestsPerSecond: 0,
  maxLiveQueries: 1_000,
  // Under API Gateway's 30-second integration timeout.
  longPollMs: 25_000,
};

/** The API's pieces, for embedding or testing without a socket. */
export interface Api {
  readonly app: Hono;
  readonly graphqlSchema: GraphQLSchema;
  readonly sdl: string;
  readonly live: LiveQueries;
  close(): Promise<void>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

class RateLimiter {
  readonly #rate: number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  constructor(rate: number) {
    this.#rate = rate;
  }
  allow(key: string): boolean {
    if (this.#rate <= 0) return true;
    const now = Date.now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#rate, at: now };
    bucket.tokens = Math.min(this.#rate, bucket.tokens + ((now - bucket.at) / 1_000) * this.#rate);
    bucket.at = now;
    const ok = bucket.tokens >= 1;
    if (ok) bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > 10_000) this.#buckets.clear();
    return ok;
  }
}

export function createApi(options: ApiOptions): Api {
  const target = makeTarget(options.schema, options.databaseSchema);
  const { app, live } = buildApp(options, () => target);
  return { app, graphqlSchema: target.graphqlSchema, sdl: target.sdl, live, close: () => live.close() };
}

type CommonOptions = Omit<ApiOptions, "schema" | "databaseSchema">;

export interface LiveApi {
  readonly app: Hono;
  readonly live: LiveQueries;
  /** The build being served, if any. */
  readonly buildId: () => string | undefined;
  /** Re-reads the active build now (also done on every cutover notification). */
  reload(): Promise<void>;
  close(): Promise<void>;
}

const CUTOVER_CHANNEL = "tidemark_cutover";

/**
 * An API that serves whatever build a live schema points at. It reads the active build's table
 * definitions from `tm_meta.builds` and queries the build's own schema, not the live views, so a
 * cutover cannot change tables under a request built for the old ones: on the cutover notification
 * it builds the new GraphQL schema and swaps it in whole, while requests already running finish on
 * the old build. Until a build is active it answers 503.
 */
export async function createLiveApi(
  options: CommonOptions & { readonly live: string; readonly pollIntervalMs?: number },
): Promise<LiveApi> {
  let target: Target | undefined;
  const reload = async () => {
    const [row] = await options.sql<{ build_id: string; schema_name: string; schema: SerializedSchema }[]>`
      select b.build_id, b.schema_name, b.schema from tm_meta.live_schemas l
      join tm_meta.builds b on b.build_id = l.active_build where l.name = ${options.live}
    `.catch(() => []);
    if (row === undefined || row.build_id === target?.buildId) return;
    target = makeTarget(deserializeSchema(row.schema), row.schema_name, row.build_id);
    holder.live?.targetChanged();
  };
  const holder: { live?: LiveQueries } = {};
  await reload();
  const listener = await options.sql.listen(CUTOVER_CHANNEL, (payload) => {
    if (payload === options.live) void reload();
  });
  // A fallback in case a notification is missed (a dropped connection, say).
  const timer = setInterval(() => void reload().catch(() => undefined), options.pollIntervalMs ?? 5_000);
  timer.unref();
  const built = buildApp({ ...options, schema: {}, databaseSchema: options.live }, () => target);
  holder.live = built.live;
  return {
    app: built.app,
    live: built.live,
    buildId: () => target?.buildId,
    reload,
    async close() {
      clearInterval(timer);
      await listener.unlisten();
      await built.live.close();
    },
  };
}

function buildApp(options: ApiOptions, current: () => Target | undefined): { app: Hono; live: LiveQueries } {
  const limits: ApiLimits = { ...defaultLimits, ...options.limits };
  const keys =
    options.apiKeyHashes === undefined
      ? undefined
      : new Set(options.apiKeyHashes.map((h) => h.toLowerCase()));
  const limiter = new RateLimiter(limits.requestsPerSecond);
  const rules = validationRules(options.introspection !== false);
  const live = new LiveQueries({
    sql: options.sql,
    current,
    limits,
    rules,
    maxSubscriptions: limits.maxLiveQueries,
  });
  const app = new Hono();
  const reply = (c: { json: (body: unknown, status: never) => Response }, outcome: Outcome) =>
    c.json(outcome.body, outcome.status as never);

  if (options.cors === true) {
    app.use("*", async (c, next) => {
      c.header("access-control-allow-origin", "*");
      c.header("access-control-allow-headers", "content-type, authorization");
      c.header("access-control-allow-methods", "GET, POST, OPTIONS");
      if (c.req.method === "OPTIONS") return c.body(null, 204);
      await next();
    });
  }

  // Request metrics, by route pattern (never the raw path, which would make a label per id).
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    // The route that finally answered (the last matched handler), not this middleware's "*".
    const matched = routePath(c as Context, -1);
    const route = matched === "/*" || matched === "*" || matched === "" ? "other" : matched;
    apiRequests.inc({ route, status: c.res.status });
    apiSeconds.observe({ route }, (performance.now() - started) / 1000);
  });

  // Auth and rate limiting for everything except liveness.
  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz" || (options.publicMetrics === true && c.req.path === "/metrics")) {
      await next();
      return;
    }
    let caller = c.req.header("x-forwarded-for") ?? "anonymous";
    if (keys !== undefined) {
      const header = c.req.header("authorization") ?? "";
      const key = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (key === "" || !keys.has(sha256(key))) return c.json({ error: "missing or invalid API key" }, 401);
      caller = sha256(key);
    }
    if (!limiter.allow(caller)) return c.json({ error: "rate limit exceeded" }, 429);
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > limits.maxBodyBytes) return c.json({ error: "request body too large" }, 413);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/metrics", async (c) => {
    liveQueries.set({}, live.size);
    return c.text(await metrics.render(), 200, { "content-type": PROMETHEUS_CONTENT_TYPE });
  });

  app.get("/readyz", async (c) => {
    try {
      await options.sql`select 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.get("/status", async (c) => {
    const target = current();
    if (target === undefined) return c.json({ error: "no active build" }, 503);
    const schemaName = target.schemaName;
    const rows = await options.sql.unsafe<
      {
        chain_id: bigint;
        block_number: bigint;
        finalized_block: bigint;
        checkpoint: string;
        updated_at: Date;
      }[]
    >(
      `select chain_id, block_number, finalized_block, checkpoint, updated_at from ${ident(schemaName)}."_tm_checkpoints" order by chain_id`,
    );
    return c.json({
      schema: schemaName,
      build: target.buildId ?? null,
      chains: rows.map((r) => ({
        chainId: Number(r.chain_id),
        blockNumber: r.block_number.toString(),
        finalizedBlock: r.finalized_block.toString(),
        checkpoint: r.checkpoint,
        updatedAt: r.updated_at.toISOString(),
        secondsSinceUpdate: Math.round((Date.now() - r.updated_at.getTime()) / 1000),
      })),
    });
  });

  app.get("/graphql/schema", (c) => {
    const target = current();
    return target === undefined ? c.json({ error: "no active build" }, 503) : c.text(target.sdl);
  });

  app.post("/graphql", async (c) => {
    // One target for the whole request, even if a cutover swaps it meanwhile.
    const target = current();
    if (target === undefined) return c.json({ errors: [{ message: "no active build" }] }, 503);
    let body: { query?: unknown; variables?: unknown; operationName?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ errors: [{ message: "body must be JSON" }] }, 400);
    }
    const prepared = prepareGraphQL(options.sql, target, limits, rules, body);
    return reply(c, isOutcome(prepared) ? prepared : await prepared.run());
  });

  app.post("/sql", async (c) => {
    const target = current();
    if (target === undefined) return c.json({ error: "no active build" }, 503);
    let body: { query?: unknown; params?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const prepared = await prepareSql(options.sql, target, limits, body);
    return reply(c, isOutcome(prepared) ? prepared : await prepared.run());
  });

  /** A live query from a request: `{ graphql: { query, variables } }` or `{ sql: { query, params } }`. */
  const liveSpec = (body: { graphql?: unknown; sql?: unknown }): LiveSpec | undefined => {
    if (typeof body.graphql === "object" && body.graphql !== null) return { graphql: body.graphql };
    if (typeof body.sql === "object" && body.sql !== null) return { sql: body.sql };
    return undefined;
  };
  const specFromQuery = (q: (name: string) => string | undefined): LiveSpec | undefined => {
    const json = (text: string | undefined) => {
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    };
    const graphql = q("graphql");
    if (graphql !== undefined) return { graphql: { query: graphql, variables: json(q("variables")) } };
    const sql = q("sql");
    if (sql !== undefined) return { sql: { query: sql, params: json(q("params")) } };
    return undefined;
  };

  const isAborted = (stream: { aborted: boolean }): boolean => stream.aborted;

  // Server-sent events: a `result` event at once and on every change. GET for EventSource
  // (`?graphql=...&variables=...` or `?sql=...&params=...`); POST with a JSON body for fetch clients.
  const sse = (c: Context, spec: LiveSpec | undefined) => {
    if (spec === undefined) return c.json({ error: "give graphql or sql" }, 400);
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      stream.onAbort(() => {
        unsubscribe?.();
        wake?.();
      });
      try {
        ({ unsubscribe } = await live.subscribe(spec, (result) => {
          queue.push(
            JSON.stringify({
              status: result.status,
              cursor: result.cursor,
              build: result.build,
              body: result.body,
            }),
          );
          wake?.();
        }));
      } catch (error) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: (error as Error).message }) });
        return;
      }
      while (!stream.aborted && !stream.closed) {
        const next = queue.shift();
        if (next !== undefined) {
          await stream.writeSSE({ event: "result", data: next });
          continue;
        }
        await new Promise<void>((resolve) => {
          const keepAlive = setTimeout(resolve, 15_000);
          wake = () => {
            clearTimeout(keepAlive);
            resolve();
          };
        });
        wake = undefined;
        if (queue.length === 0 && !isAborted(stream)) await stream.write(": keep-alive\n\n");
      }
      unsubscribe();
    });
  };
  app.get("/live/sse", (c) =>
    sse(
      c,
      specFromQuery((name) => c.req.query(name)),
    ),
  );
  app.post("/live/sse", async (c) => {
    let body: { graphql?: unknown; sql?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    return sse(c, liveSpec(body));
  });

  // Long-poll, for proxies that cut long-lived connections: answers at once when the result differs
  // from `cursor`, else when it changes, or after `longPollMs` with `changed: false`.
  app.post("/live/poll", async (c) => {
    let body: { graphql?: unknown; sql?: unknown; cursor?: unknown; timeoutMs?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const spec = liveSpec(body);
    if (spec === undefined) return c.json({ error: "give graphql or sql" }, 400);
    const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
    const wait = Math.min(
      limits.longPollMs,
      typeof body.timeoutMs === "number" ? Math.max(0, body.timeoutMs) : limits.longPollMs,
    );
    try {
      const result = await live.poll(spec, cursor, wait, c.req.raw.signal);
      return c.json({
        changed: result.changed,
        status: result.status,
        cursor: result.cursor,
        build: result.build,
        body: result.body,
      });
    } catch (error) {
      if (error instanceof LiveLimitError) return c.json({ error: error.message }, 503);
      throw error;
    }
  });

  app.onError((error, c) =>
    c.json({ error: error instanceof GraphQLError ? error.message : "internal error" }, 500),
  );

  return { app, live };
}

/** Serves the API over HTTP. Resolves once listening. */
export async function serveApi(
  options: ApiOptions & { readonly port: number; readonly hostname?: string },
): Promise<{ server: ServerType; url: string; close(): Promise<void> }> {
  const { app, live } = createApi(options);
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: options.port, hostname: options.hostname ?? "127.0.0.1" },
      (info) => {
        const ws = attachWebSocket(server, {
          live,
          ...(options.apiKeyHashes === undefined ? {} : { apiKeyHashes: options.apiKeyHashes }),
        });
        resolve({
          server,
          url: `http://${info.address.includes(":") ? `[${info.address}]` : info.address}:${info.port}`,
          close: async () => {
            await ws.close();
            await live.close();
            await new Promise<void>((done) => {
              server.close(() => {
                done();
              });
            });
          },
        });
      },
    );
  });
}

/**
 * Serves any Hono app (for example a live API's) over HTTP; with `live`, also live queries over
 * WebSocket at `/graphql/ws`. Resolves once listening.
 */
export async function serveApp(
  app: Hono,
  port: number,
  hostname = "127.0.0.1",
  options: { live?: LiveQueries; apiKeyHashes?: readonly string[] } = {},
): Promise<{ server: ServerType; url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const ws =
        options.live === undefined
          ? undefined
          : attachWebSocket(server, {
              live: options.live,
              ...(options.apiKeyHashes === undefined ? {} : { apiKeyHashes: options.apiKeyHashes }),
            });
      resolve({
        server,
        url: `http://${info.address.includes(":") ? `[${info.address}]` : info.address}:${info.port}`,
        close: async () => {
          await ws?.close();
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          });
        },
      });
    });
  });
}
