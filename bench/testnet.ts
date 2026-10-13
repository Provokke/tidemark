/**
 * End to end against a real chain (the nightly workflow): index the last 2,000 finalised blocks of
 * the WETH predeploy on Base Sepolia into a fresh database, check every row against an independent
 * `eth_getLogs`, then prove the cached logs of 200 blocks against their receipts roots.
 *
 *   TESTNET_RPC_URL=https://... TIDEMARK_TEST_DATABASE_URL=postgres://... pnpm testnet
 */
import { normalizeLogFilter } from "@tidemark/core";
import { createTidemark, defineConfig, runHistorical } from "@tidemark/engine";
import { connect } from "@tidemark/pg";
import { RpcPool } from "@tidemark/rpc";
import { onchainTable, t } from "@tidemark/schema";
import { SyncStore, verifyCache } from "@tidemark/sync";
import { createTestDatabase } from "@tidemark/testing";
import { parseAbi } from "viem";

const rpc = process.env.TESTNET_RPC_URL;
if (rpc === undefined || rpc === "") throw new Error("set TESTNET_RPC_URL (Base Sepolia)");
const CHAIN_ID = 84_532;
const WETH = "0x4200000000000000000000000000000000000006";
const SPAN = 2_000;
const abi = parseAbi([
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Transfer(address indexed src, address indexed dst, uint256 wad)",
  "event Approval(address indexed src, address indexed guy, uint256 wad)",
]);

const pool = new RpcPool({ chainId: CHAIN_ID, endpoints: [rpc] });
const finalized = (await pool.finalizedBlock({ kind: "tag" })).number;
const startBlock = finalized - SPAN + 1;

const movement = onchainTable("movement", {
  id: t.text().primaryKey(),
  kind: t.text().notNull(),
  block: t.bigint().notNull(),
  amount: t.bigint().notNull(),
});
const tidemark = createTidemark(
  defineConfig({
    chains: { baseSepolia: { id: CHAIN_ID, rpc, finality: "tag", verify: "bloom" } },
    contracts: { Weth: { chain: "baseSepolia", abi, address: WETH, startBlock, endBlock: finalized } },
  }),
);
for (const kind of ["Deposit", "Withdrawal", "Transfer", "Approval"] as const) {
  tidemark.on(`Weth:${kind}`, async ({ event, context }) => {
    await context.db.insert(movement).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      kind,
      block: event.block.number,
      amount: (event.args as { wad: bigint }).wad,
    });
  });
}

const db = await createTestDatabase();
const sql = connect(db.url, { max: 8 });
try {
  const started = Date.now();
  await runHistorical({ tidemark, schema: { movement }, sql, indexSchema: "testnet" });
  const seconds = (Date.now() - started) / 1000;

  // An independent reading of the same range, straight from the node.
  const filter = normalizeLogFilter({ chainId: CHAIN_ID, address: WETH });
  const expected = new Set<string>();
  for (let from = startBlock; from <= finalized; from += 500) {
    for (const log of await pool.getLogs(filter, from, Math.min(finalized, from + 499))) {
      expected.add(`${log.transactionHash}-${log.logIndex}`);
    }
  }
  const rows = await sql<{ id: string }[]>`select id from testnet.movement`;
  const indexed = new Set(rows.map((r) => r.id));
  const missing = [...expected].filter((id) => !indexed.has(id));
  const extra = [...indexed].filter((id) => !expected.has(id));

  const store = new SyncStore(sql);
  const [proof] = await verifyCache(store, pool, {
    chainId: CHAIN_ID,
    from: finalized - 199,
    to: finalized,
    mode: "receipts-root",
  });

  const result = {
    benchmark: "testnet-e2e",
    chainId: CHAIN_ID,
    blocks: SPAN,
    rows: indexed.size,
    missing: missing.length,
    extra: extra.length,
    receiptsProvenBlocks: proof?.blocksChecked ?? 0,
    badBlocks: proof?.badBlocks.length ?? 0,
    seconds,
  };
  console.log(JSON.stringify(result));
  if (missing.length > 0 || extra.length > 0 || (proof?.badBlocks.length ?? 0) > 0) process.exitCode = 1;
} finally {
  await sql.end();
  await db.drop();
}
