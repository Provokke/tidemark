import { type LogFilter, logMatches } from "@tidemark/core";
import type { RpcPool } from "../pool.js";
import type { Hex, RpcBlockHeader, RpcLog } from "../types.js";
import { type RawReceipt, bloomMayContain, encodeReceipt, logsBloom, orderedTrieRoot } from "./primitives.js";

export type VerifyMode = "head-check" | "bloom" | "receipts-root";

/** The chain's data does not check out against its headers. */
export class VerificationError extends Error {
  override name = "VerificationError";
  readonly blockNumber: number;
  constructor(blockNumber: number, message: string) {
    super(`block ${blockNumber}: ${message}`);
    this.blockNumber = blockNumber;
  }
}

/** Whether a block's bloom says the filter may have logs in it (false: certainly none). */
export function bloomMayMatch(bloom: Hex, filter: LogFilter): boolean {
  if (filter.address !== null && !filter.address.some((a) => bloomMayContain(bloom, a))) return false;
  return filter.topics.every((options) => options === null || options.some((t) => bloomMayContain(bloom, t)));
}

export interface BloomReport {
  /** Blocks whose logs the range answer left out, and that a by-hash fetch found. */
  readonly repaired: readonly number[];
  /** Blocks the bloom said might match but that have no matching logs (bloom false positives). */
  readonly falsePositives: number;
}

const byBlock = (logs: readonly RpcLog[]) => {
  const map = new Map<number, RpcLog[]>();
  for (const log of logs) {
    const list = map.get(log.blockNumber) ?? [];
    list.push(log);
    map.set(log.blockNumber, list);
  }
  return map;
};

/**
 * `bloom` mode: checks an `eth_getLogs` answer for [from, to] against every block header's bloom.
 * A log the header's bloom cannot contain, or one from a block hash that is not the header's, is
 * an error (the node returned data that is not on the chain). A block whose bloom says the filter
 * may match but that came back empty is fetched again by block hash; logs found then replace the
 * empty answer (a node that answered a range short). Returns the checked, possibly repaired logs.
 */
export async function verifyLogsWithBloom(
  pool: RpcPool,
  filter: LogFilter,
  from: number,
  to: number,
  logs: readonly RpcLog[],
): Promise<{ logs: RpcLog[]; report: BloomReport }> {
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const headers = await pool.getBlockHeaders(numbers);
  const found = byBlock(logs);
  const out: RpcLog[] = [];
  const repaired: number[] = [];
  let falsePositives = 0;
  for (const header of headers) {
    const blockLogs = found.get(header.number) ?? [];
    for (const log of blockLogs) {
      if (log.blockHash.toLowerCase() !== header.hash.toLowerCase()) {
        throw new VerificationError(
          header.number,
          `a log names block ${log.blockHash}, the header is ${header.hash}`,
        );
      }
      if (
        !bloomMayContain(header.logsBloom, log.address) ||
        !log.topics.every((t) => bloomMayContain(header.logsBloom, t))
      ) {
        throw new VerificationError(header.number, `log ${log.logIndex} is not in the header's bloom`);
      }
    }
    if (blockLogs.length === 0 && bloomMayMatch(header.logsBloom, filter)) {
      const [again = []] = await pool.getBlockLogs(header.hash, [filter]);
      const matching = again.filter((l) => logMatches(filter, l));
      if (matching.length > 0) {
        repaired.push(header.number);
        out.push(...matching);
      } else falsePositives++;
      continue;
    }
    out.push(...blockLogs);
  }
  out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return { logs: out, report: { repaired, falsePositives } };
}

/**
 * Fetches a block's receipts and proves them against its header: the receipts trie rebuilt from
 * them must have the header's `receiptsRoot`, and their blooms together the header's `logsBloom`.
 */
export async function verifiedReceipts(pool: RpcPool, header: RpcBlockHeader): Promise<RawReceipt[]> {
  if (header.receiptsRoot === undefined)
    throw new VerificationError(header.number, "the header has no receiptsRoot");
  const raw = await pool.request("eth_getBlockReceipts", [header.hash]);
  if (!Array.isArray(raw))
    throw new VerificationError(header.number, "eth_getBlockReceipts returned no list");
  const receipts = raw as RawReceipt[];
  const root = orderedTrieRoot(receipts.map(encodeReceipt));
  if (root.toLowerCase() !== header.receiptsRoot.toLowerCase()) {
    throw new VerificationError(
      header.number,
      `receipts root ${root} is not the header's ${header.receiptsRoot}`,
    );
  }
  const bloom = logsBloom(receipts.flatMap((r) => r.logs));
  if (bloom.toLowerCase() !== header.logsBloom.toLowerCase()) {
    throw new VerificationError(header.number, "the receipts' logs do not make the header's bloom");
  }
  return receipts;
}

interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex?: string;
  readonly transactionHash?: string;
  readonly transactionIndex?: string;
}

/**
 * `receipts-root` mode: the filter's logs in [from, to], derived from receipts proven against each
 * block header. Nothing a node says about logs is trusted beyond what the header commits to.
 */
export async function logsFromVerifiedReceipts(
  pool: RpcPool,
  filter: LogFilter,
  from: number,
  to: number,
): Promise<RpcLog[]> {
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const headers = await pool.getBlockHeaders(numbers);
  const out: RpcLog[] = [];
  for (const header of headers) {
    // Skip blocks the header's bloom rules out: the bloom is part of what the root proves.
    if (!bloomMayMatch(header.logsBloom, filter)) continue;
    const receipts = await verifiedReceipts(pool, header);
    let logIndex = 0;
    receipts.forEach((receipt, txIndex) => {
      for (const log of receipt.logs as readonly ReceiptLog[]) {
        const parsed: RpcLog = {
          blockNumber: header.number,
          blockHash: header.hash,
          transactionHash: (log.transactionHash ?? "0x") as Hex,
          transactionIndex: txIndex,
          logIndex: logIndex++,
          address: log.address.toLowerCase() as Hex,
          topics: log.topics.map((t) => t.toLowerCase() as Hex),
          data: log.data.toLowerCase() as Hex,
        };
        if (logMatches(filter, parsed)) out.push(parsed);
      }
    });
  }
  return out;
}
