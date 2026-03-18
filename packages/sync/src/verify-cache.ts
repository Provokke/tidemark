import { type Interval, type LogFilter, intersect, normalizeLogFilter } from "@tidemark/core";
import {
  type RpcLog,
  type RpcPool,
  VerificationError,
  logsFromVerifiedReceipts,
  verifyLogsWithBloom,
} from "@tidemark/rpc";
import type { SyncStore } from "./store.js";

export interface CacheCheck {
  readonly filterHash: string;
  readonly blocksChecked: number;
  /** Blocks whose cached logs differ from what the headers prove. */
  readonly badBlocks: readonly number[];
}

export interface VerifyCacheOptions {
  readonly chainId: number;
  readonly from: number;
  readonly to: number;
  readonly mode: "bloom" | "receipts-root";
  /** Blocks checked per request batch. Default 200. */
  readonly chunk?: number;
  /** Forget bad blocks: drop their cached logs and remove them from every interval, so the next run fetches them again. */
  readonly repair?: boolean;
  readonly onProgress?: (check: CacheCheck) => void;
}

const key = (l: RpcLog) =>
  `${l.blockNumber}:${l.logIndex}:${l.address.toLowerCase()}:${l.topics.join(",")}:${l.data.toLowerCase()}`;

function isLogFilter(value: unknown): value is LogFilter {
  const v = value as Partial<LogFilter> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray(v.topics) &&
    (v.topics as readonly unknown[]).length === 4 &&
    "address" in v
  );
}

/**
 * Re-checks cached log ranges of one chain against block headers, after a provider incident or as
 * an audit: every cached log filter's covered blocks in [from, to], in `bloom` or `receipts-root`
 * mode. Reports the blocks whose cached logs differ; with `repair`, forgets them.
 */
export async function verifyCache(
  store: SyncStore,
  pool: RpcPool,
  options: VerifyCacheOptions,
): Promise<CacheCheck[]> {
  const rows = await store.sql<{ filter_hash: string; filter: unknown }[]>`
    select filter_hash, filter from tm_sync.intervals where chain_id = ${options.chainId} order by filter_hash
  `;
  const checks: CacheCheck[] = [];
  const bad = new Set<number>();
  for (const row of rows) {
    // Log sources store their spec (or, from `commitRange`, the bare filter); block, trace and
    // factory sources have nothing to check here.
    const spec = row.filter as { kind?: unknown; filter?: unknown } | null;
    const raw = spec !== null && spec.kind === "log" ? spec.filter : row.filter;
    if (!isLogFilter(raw)) continue;
    const filter = normalizeLogFilter(raw);
    const covered = intersect(await store.cachedIntervals(options.chainId, row.filter_hash), [
      [options.from, options.to],
    ]);
    const badBlocks: number[] = [];
    let blocksChecked = 0;
    for (const [start, end] of covered) {
      for (let a = start; a <= end; a += options.chunk ?? 200) {
        const b = Math.min(end, a + (options.chunk ?? 200) - 1);
        const cached = await store.readLogs(filter, a, b);
        let proven: readonly RpcLog[];
        try {
          proven =
            options.mode === "receipts-root"
              ? await logsFromVerifiedReceipts(pool, filter, a, b)
              : (await verifyLogsWithBloom(pool, filter, a, b, cached)).logs;
        } catch (error) {
          // A cached log the header's bloom rules out: that block is bad.
          if (!(error instanceof VerificationError)) throw error;
          badBlocks.push(error.blockNumber);
          continue;
        }
        const have = new Set(cached.map(key));
        const want = new Set(proven.map(key));
        const differing = new Set<number>();
        for (const l of cached) if (!want.has(key(l))) differing.add(l.blockNumber);
        for (const l of proven) if (!have.has(key(l))) differing.add(l.blockNumber);
        badBlocks.push(...differing);
        blocksChecked += b - a + 1;
      }
    }
    badBlocks.sort((x, y) => x - y);
    for (const n of badBlocks) bad.add(n);
    const check = { filterHash: row.filter_hash, blocksChecked, badBlocks };
    checks.push(check);
    options.onProgress?.(check);
  }
  if (options.repair === true && bad.size > 0) await forgetBlocks(store, options.chainId, [...bad]);
  return checks;
}

/** Removes blocks from every cached interval of a chain and drops their cached logs. */
export async function forgetBlocks(
  store: SyncStore,
  chainId: number,
  blocks: readonly number[],
): Promise<void> {
  const ranges: Interval[] = [...new Set(blocks)].sort((a, b) => a - b).map((n) => [n, n]);
  const multirange = `{${ranges.map(([a, b]) => `[${a},${b + 1})`).join(",")}}`;
  await store.sql.begin(async (tx) => {
    await tx`update tm_sync.intervals set blocks = blocks - ${multirange}::int8multirange, updated_at = now() where chain_id = ${chainId}`;
    await tx`delete from tm_sync.logs where chain_id = ${chainId} and block_number = any(${blocks as number[]}::int8[])`;
  });
}
