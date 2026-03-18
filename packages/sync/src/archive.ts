import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { type AwsCredentials, signV4 } from "@tidemark/core";
import type { SyncStore } from "./store.js";

/** Where an archive goes: a directory, or an S3 prefix. */
export interface ArchiveStorage {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** For messages: where `key` lives. */
  describe(key: string): string;
}

export function directoryStorage(root: string): ArchiveStorage {
  return {
    async put(key, body) {
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      return readFile(join(root, key));
    },
    describe: (key) => join(root, key),
  };
}

export interface S3Options {
  readonly bucket: string;
  readonly prefix?: string;
  readonly region: string;
  /** For S3-compatible stores (MinIO, R2): path-style requests to this endpoint. */
  readonly endpoint?: string;
  /** Default: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN. */
  readonly credentials?: AwsCredentials;
  readonly fetch?: typeof fetch;
}

/** S3 with SigV4, no SDK: PUT and GET of whole objects. */
export function s3Storage(options: S3Options): ArchiveStorage {
  const credentials = (): AwsCredentials => {
    if (options.credentials !== undefined) return options.credentials;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (accessKeyId === undefined || secretAccessKey === undefined)
      throw new Error("no AWS credentials in the environment");
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) };
  };
  const get = options.fetch ?? fetch;
  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const urlFor = (key: string) => {
    const objectKey = [prefix, key].filter(Boolean).join("/");
    const encoded = objectKey.split("/").map(encodeURIComponent).join("/");
    return options.endpoint === undefined
      ? new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com/${encoded}`)
      : new URL(`${options.endpoint.replace(/\/$/, "")}/${options.bucket}/${encoded}`);
  };
  const request = async (method: "PUT" | "GET", key: string, body?: Uint8Array) => {
    const url = urlFor(key);
    const hash = createHash("sha256")
      .update(body ?? new Uint8Array(0))
      .digest("hex");
    const headers = signV4({
      method,
      url,
      headers: { "x-amz-content-sha256": hash },
      body: body ?? "",
      region: options.region,
      service: "s3",
      credentials: credentials(),
    });
    delete headers.host;
    const response = await get(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: Buffer.from(body) }),
    });
    if (!response.ok)
      throw new Error(
        `S3 ${method} ${url.pathname}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    return response;
  };
  return {
    async put(key, body) {
      await request("PUT", key, body);
    },
    async get(key) {
      return new Uint8Array(await (await request("GET", key)).arrayBuffer());
    },
    describe: (key) => `s3://${options.bucket}/${[prefix, key].filter(Boolean).join("/")}`,
  };
}

/** `s3://bucket/prefix` or a directory path. */
export function storageFor(
  target: string,
  s3: Omit<S3Options, "bucket" | "prefix"> = { region: process.env.AWS_REGION ?? "us-east-1" },
): ArchiveStorage {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(target);
  if (match === null) return directoryStorage(target);
  return s3Storage({ ...s3, bucket: match[1] as string, prefix: match[2] ?? "" });
}

/** The sync cache's tables, in import order (intervals last, so a half-imported archive claims nothing). */
const TABLES = [
  "blocks",
  "logs",
  "traces",
  "factory_children",
  "transactions",
  "receipts",
  "rpc_cache",
] as const;
const ROWS_PER_PART = 100_000;

export interface ArchiveManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly chains: readonly number[];
  readonly parts: Readonly<
    Record<string, readonly { readonly key: string; readonly rows: number; readonly sha256: string }[]>
  >;
  readonly intervals: readonly {
    readonly chain_id: string;
    readonly filter_hash: string;
    readonly filter: unknown;
    readonly blocks: string;
  }[];
}

/**
 * Writes the sync cache (for some chains, or all) as gzipped NDJSON parts and a manifest. Only
 * finalised data is ever in the cache, so an archive is safe to import anywhere, for the same chains.
 */
export async function exportCache(
  store: SyncStore,
  storage: ArchiveStorage,
  options: { chains?: readonly number[]; onPart?: (key: string, rows: number) => void } = {},
): Promise<ArchiveManifest> {
  const sql = store.sql;
  await store.migrate();
  const chains =
    options.chains ??
    (await sql<{ chain_id: bigint }[]>`select distinct chain_id from tm_sync.intervals order by 1`).map((r) =>
      Number(r.chain_id),
    );
  const parts: Record<string, { key: string; rows: number; sha256: string }[]> = {};
  for (const table of TABLES) {
    parts[table] = [];
    let lines: string[] = [];
    const flush = async () => {
      if (lines.length === 0) return;
      const key = `${table}/part-${String(parts[table]?.length ?? 0).padStart(5, "0")}.ndjson.gz`;
      const body = gzipSync(`${lines.join("\n")}\n`);
      await storage.put(key, body);
      parts[table]?.push({
        key,
        rows: lines.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      options.onPart?.(key, lines.length);
      lines = [];
    };
    const cursor = sql
      .unsafe<{ j: string }[]>(
        `select row_to_json(t)::text as j from tm_sync.${table} t where t.chain_id = any($1::int8[])`,
        [chains as number[]],
      )
      .cursor(5_000);
    for await (const batch of cursor) {
      for (const row of batch) {
        lines.push(row.j);
        if (lines.length >= ROWS_PER_PART) await flush();
      }
    }
    await flush();
  }
  const intervals = await sql<{ chain_id: string; filter_hash: string; filter: unknown; blocks: string }[]>`
    select chain_id::text, filter_hash, filter, blocks::text from tm_sync.intervals where chain_id = any(${chains as number[]}::int8[])
  `;
  const manifest: ArchiveManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    chains,
    parts,
    intervals: [...intervals],
  };
  await storage.put("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  return manifest;
}

/**
 * Imports an archive into this database's sync cache: rows that already exist are kept, and
 * intervals are merged. Each part's checksum is checked before anything from it is written.
 */
export async function importCache(
  store: SyncStore,
  storage: ArchiveStorage,
  options: { onPart?: (key: string, rows: number) => void } = {},
): Promise<ArchiveManifest> {
  const sql = store.sql;
  const manifest = JSON.parse(Buffer.from(await storage.get("manifest.json")).toString()) as ArchiveManifest;
  if ((manifest.version as number) !== 1)
    throw new Error(`unknown archive version ${String(manifest.version)}`);
  await store.migrate();
  for (const chainId of manifest.chains) await store.ensureChain(chainId);
  for (const table of TABLES) {
    for (const part of manifest.parts[table] ?? []) {
      const body = await storage.get(part.key);
      if (createHash("sha256").update(body).digest("hex") !== part.sha256)
        throw new Error(`${storage.describe(part.key)}: checksum mismatch`);
      const lines = gunzipSync(body)
        .toString()
        .split("\n")
        .filter((l) => l !== "");
      for (let i = 0; i < lines.length; i += 2_000) {
        const chunk = `[${lines.slice(i, i + 2_000).join(",")}]`;
        await sql.unsafe(
          `insert into tm_sync.${table} select * from json_populate_recordset(null::tm_sync.${table}, $1::text::json) on conflict do nothing`,
          [chunk],
        );
      }
      options.onPart?.(part.key, lines.length);
    }
  }
  for (const i of manifest.intervals) {
    await sql`
      insert into tm_sync.intervals (chain_id, filter_hash, filter, blocks)
      values (${i.chain_id}::int8, ${i.filter_hash}, ${sql.json(i.filter as never)}, ${i.blocks}::int8multirange)
      on conflict (chain_id, filter_hash) do update set blocks = tm_sync.intervals.blocks + excluded.blocks, updated_at = now()
    `;
  }
  return manifest;
}
