import type { AnyTable, InferSelect } from "@tidemark/schema";
import {
  CamelCasePlugin,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";

/** The Kysely database type for a schema module: each table by its name, columns in camelCase. */
export type ClientDatabase<S> = {
  [K in keyof S as S[K] extends AnyTable ? S[K]["name"] : never]: S[K] extends AnyTable
    ? InferSelect<S[K]>
    : never;
};

export interface ClientOptions {
  /** The API's base URL, e.g. `https://indexer.example.com`. */
  readonly url: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  /**
   * How a `0x…` string parameter is sent. `"bytea"` (the default) sends it as bytes, so it compares
   * equal to `t.hex()` columns; `"text"` sends it as written, for text columns holding hex.
   */
  readonly hexParams?: "bytea" | "text";
}

export interface SqlResult {
  readonly columns: readonly { readonly name: string; readonly type: number }[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

/** The API answered with an error. */
export class TidemarkClientError extends Error {
  override name = "TidemarkClientError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const OID = { int8: 20, numeric: 1700, timestamptz: 1184, timestamp: 1114 } as const;
const INTEGER = /^-?\d+$/;

function decode(value: unknown, type: number): unknown {
  if (value === null) return null;
  if ((type === OID.int8 || type === OID.numeric) && typeof value === "string" && INTEGER.test(value))
    return BigInt(value);
  if ((type === OID.timestamptz || type === OID.timestamp) && typeof value === "string")
    return new Date(value);
  return value;
}

const HEX = /^0x([0-9a-fA-F]{2})*$/;

function encodeParam(value: unknown, hexParams: "bytea" | "text"): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array)
    return `\\x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (typeof value === "string" && hexParams === "bytea" && HEX.test(value)) return `\\x${value.slice(2)}`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

async function post(options: ClientOptions, path: string, body: unknown): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${options.url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as {
    error?: string;
    errors?: { message: string }[];
  };
  if (!response.ok) {
    throw new TidemarkClientError(
      response.status,
      json.error ?? json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${response.status}`,
    );
  }
  return json;
}

/** Runs a read-only query against the SQL endpoint. Values are decoded by their Postgres type. */
export async function runSql(
  options: ClientOptions,
  query: string,
  params: readonly unknown[] = [],
): Promise<SqlResult> {
  const hexParams = options.hexParams ?? "bytea";
  const body = (await post(options, "/sql", {
    query,
    params: params.map((p) => encodeParam(p, hexParams)),
  })) as {
    columns: { name: string; type: number }[];
    rows: unknown[][];
    truncated: boolean;
  };
  return {
    columns: body.columns,
    rows: body.rows.map((row) =>
      Object.fromEntries(body.columns.map((c, i) => [c.name, decode(row[i], c.type)])),
    ),
    truncated: body.truncated,
  };
}

class HttpConnection implements DatabaseConnection {
  readonly #options: ClientOptions;
  constructor(options: ClientOptions) {
    this.#options = options;
  }
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await runSql(this.#options, compiled.sql, compiled.parameters);
    return { rows: result.rows as R[] };
  }
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("streaming is not supported by the Tidemark client");
  }
}

class HttpDriver implements Driver {
  readonly #connection: HttpConnection;
  constructor(options: ClientOptions) {
    this.#connection = new HttpConnection(options);
  }
  async init(): Promise<void> {}
  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.#connection);
  }
  beginTransaction(): Promise<void> {
    return Promise.reject(new Error("the Tidemark API is read-only: transactions are not available"));
  }
  commitTransaction(): Promise<void> {
    return Promise.reject(new Error("the Tidemark API is read-only: transactions are not available"));
  }
  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error("the Tidemark API is read-only: transactions are not available"));
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/** A Kysely dialect that sends compiled queries to a Tidemark API's SQL endpoint. */
export class TidemarkDialect implements Dialect {
  readonly #options: ClientOptions;
  constructor(options: ClientOptions) {
    this.#options = options;
  }
  createAdapter() {
    return new PostgresAdapter();
  }
  createDriver() {
    return new HttpDriver(this.#options);
  }
  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }
  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
}

/** What a live query watches: GraphQL, raw SQL, or a query builder (anything with `compile()`). */
export type LiveQuery =
  | { readonly graphql: string; readonly variables?: Record<string, unknown> }
  | { readonly sql: string; readonly params?: readonly unknown[] }
  | { compile(): { readonly sql: string; readonly parameters: readonly unknown[] } };

export interface LiveOptions {
  /** `"sse"` (default) holds one streaming response; `"poll"` long-polls, for proxies that cut those. */
  readonly transport?: "sse" | "poll";
  /** Errors from the API or the network. The live query keeps retrying until unsubscribed. */
  readonly onError?: (error: Error) => void;
  /** Longest wait between reconnects. Default 10 seconds. */
  readonly maxBackoffMs?: number;
}

export interface LiveMeta {
  /** Changes whenever the result does. */
  readonly cursor: string;
  readonly build: string | null;
}

function liveBody(query: LiveQuery, hexParams: "bytea" | "text"): { graphql?: unknown; sql?: unknown } {
  if ("graphql" in query) return { graphql: { query: query.graphql, variables: query.variables } };
  const { sql, params } =
    "sql" in query
      ? { sql: query.sql, params: query.params ?? [] }
      : (({ sql: q, parameters }) => ({ sql: q, params: parameters }))(query.compile());
  return { sql: { query: sql, params: params.map((p) => encodeParam(p, hexParams)) } };
}

/** A pushed result as the caller sees it: GraphQL `data`, or decoded SQL rows. */
function liveData(query: LiveQuery, status: number, body: unknown): unknown {
  const b = body as {
    data?: unknown;
    errors?: { message: string }[];
    error?: string;
    columns?: { name: string; type: number }[];
    rows?: unknown[][];
  };
  if (status >= 400 || b.error !== undefined)
    throw new TidemarkClientError(
      status,
      b.error ?? b.errors?.map((e) => e.message).join("; ") ?? `HTTP ${status}`,
    );
  if ("graphql" in query) {
    if (b.errors !== undefined && b.errors.length > 0)
      throw new TidemarkClientError(200, b.errors.map((e) => e.message).join("; "));
    return b.data;
  }
  const columns = b.columns ?? [];
  return (b.rows ?? []).map((row) =>
    Object.fromEntries(columns.map((c, i) => [c.name, decode(row[i], c.type)])),
  );
}

/**
 * Subscribes to a live query: `onData` gets the current result at once and again whenever it
 * changes. Reconnects with backoff after a dropped connection. Returns the unsubscribe function.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- lets callers name the result type
export function live<T = unknown>(
  options: ClientOptions,
  query: LiveQuery,
  onData: (data: T, meta: LiveMeta) => void,
  liveOptions: LiveOptions = {},
): () => void {
  const controller = new AbortController();
  const stopped = (): boolean => controller.signal.aborted;
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
  };
  const body = liveBody(query, options.hexParams ?? "bytea");
  let cursor: string | undefined;
  const deliver = (status: number, resultBody: unknown, meta: LiveMeta) => {
    if (meta.cursor === cursor) return;
    cursor = meta.cursor;
    onData(liveData(query, status, resultBody) as T, meta);
  };
  const fail = (error: unknown) => {
    if (controller.signal.aborted) return;
    liveOptions.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const sse = async () => {
    const response = await doFetch(`${base}/live/sse`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => "");
      throw new TidemarkClientError(response.status, text || `HTTP ${response.status}`);
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (event === "result" && data !== "") {
          const r = JSON.parse(data) as {
            status: number;
            cursor: string;
            build: string | null;
            body: unknown;
          };
          try {
            deliver(r.status, r.body, { cursor: r.cursor, build: r.build });
          } catch (error) {
            fail(error);
          }
        } else if (event === "error") throw new TidemarkClientError(503, data);
      }
    }
  };

  const poll = async () => {
    for (;;) {
      const response = await doFetch(`${base}/live/poll`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, ...(cursor === undefined ? {} : { cursor }) }),
        signal: controller.signal,
      });
      const r = (await response.json()) as {
        error?: string;
        changed?: boolean;
        status: number;
        cursor: string;
        build: string | null;
        body: unknown;
      };
      if (!response.ok) throw new TidemarkClientError(response.status, r.error ?? `HTTP ${response.status}`);
      if (r.changed === true) {
        try {
          deliver(r.status, r.body, { cursor: r.cursor, build: r.build });
        } catch (error) {
          fail(error);
        }
      }
    }
  };

  void (async () => {
    let backoff = 250;
    while (!controller.signal.aborted) {
      const started = Date.now();
      try {
        await (liveOptions.transport === "poll" ? poll() : sse());
      } catch (error) {
        fail(error);
      }
      if (stopped()) return;
      if (Date.now() - started > 30_000) backoff = 250; // it was up for a while: reconnect soon
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(liveOptions.maxBackoffMs ?? 10_000, backoff * 2);
    }
  })();
  return () => {
    controller.abort();
  };
}

export interface TidemarkClient<S> {
  /** A typed, read-only query builder over the API's tables. */
  readonly db: Kysely<ClientDatabase<S>>;
  /** Runs raw read-only SQL. */
  sql(query: string, params?: readonly unknown[]): Promise<SqlResult>;
  /** Runs a GraphQL query. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** The indexer's progress per chain. */
  status(): Promise<unknown>;
  /**
   * A live query: `onData` at once and on every change. SQL and builder results arrive as decoded
   * rows; GraphQL as `data`. Returns the unsubscribe function.
   *
   *     const stop = client.live(client.db.selectFrom("account").selectAll().orderBy("balance", "desc").limit(10),
   *       (rows) => render(rows));
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- lets callers name the result type
  live<T = unknown>(
    query: LiveQuery,
    onData: (data: T, meta: LiveMeta) => void,
    options?: LiveOptions,
  ): () => void;
}

/**
 * A client for a Tidemark API, typed from the project's schema module:
 *
 *     import * as schema from "./tidemark.schema";
 *     const client = createClient({ url }, schema);
 *     const rows = await client.db.selectFrom("swap").selectAll().where("amount0", ">", 10n ** 24n).execute();
 *
 * The schema is used for types only and is not sent anywhere.
 */
export function createClient<S extends Record<string, unknown>>(
  options: ClientOptions,
  _schema?: S,
): TidemarkClient<S> {
  const db = new Kysely<ClientDatabase<S>>({
    dialect: new TidemarkDialect(options),
    plugins: [new CamelCasePlugin()],
  });
  return {
    db,
    sql: (query, params) => runSql(options, query, params),
    live: (query, onData, liveOptions) => live(options, query, onData, liveOptions),
    async graphql<T>(query: string, variables?: Record<string, unknown>) {
      const body = (await post(options, "/graphql", { query, variables })) as {
        data: T;
        errors?: { message: string }[];
      };
      if (body.errors !== undefined && body.errors.length > 0) {
        throw new TidemarkClientError(200, body.errors.map((e) => e.message).join("; "));
      }
      return body.data;
    },
    async status() {
      const doFetch = options.fetch ?? fetch;
      const response = await doFetch(`${options.url.replace(/\/$/, "")}/status`, {
        headers: options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
      });
      if (!response.ok) throw new TidemarkClientError(response.status, `HTTP ${response.status}`);
      return response.json();
    },
  };
}
