/**
 * Proves a range of real blocks' receipts against their headers: the receipts trie rebuilt from
 * `eth_getBlockReceipts` must match each header's `receiptsRoot`, and the receipts' logs its bloom.
 *
 *   RPC_URL=https://... CHAIN_ID=1 FROM=21000000 COUNT=10000 pnpm tsx scripts/verify-receipts.ts
 *
 * Exits non-zero on the first block that does not prove out.
 */
import { RpcPool, verifiedReceipts } from "../src/index.js";

const url = process.env.RPC_URL;
if (url === undefined) throw new Error("set RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 1);
const pool = new RpcPool({ chainId, endpoints: [url] });
const head = (await pool.finalizedBlock({ kind: "tag" })).number;
const count = Number(process.env.COUNT ?? 10_000);
const from = Number(process.env.FROM ?? head - count + 1);
const started = Date.now();
let receipts = 0;
const types = new Map<string, number>();
for (let n = from; n < from + count; n += 50) {
  const headers = await pool.getBlockHeaders(
    Array.from({ length: Math.min(50, from + count - n) }, (_, i) => n + i),
  );
  await Promise.all(
    headers.map(async (header) => {
      const proven = await verifiedReceipts(pool, header);
      receipts += proven.length;
      for (const r of proven) types.set(r.type ?? "0x0", (types.get(r.type ?? "0x0") ?? 0) + 1);
    }),
  );
  process.stderr.write(`\rproved blocks ${from}..${n + 49} (${receipts} receipts)`);
}
process.stderr.write("\n");
console.log(
  JSON.stringify({
    chainId,
    from,
    to: from + count - 1,
    blocks: count,
    receipts,
    types: Object.fromEntries(types),
    seconds: (Date.now() - started) / 1000,
  }),
);
