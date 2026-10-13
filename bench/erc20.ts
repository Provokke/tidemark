/**
 * ERC-20 indexing throughput from the sync cache.
 *
 * Generates TRANSFERS transfers on Anvil with `batchTransfer`, fills the sync cache once, then
 * times a second, independent index of the same range: every event is read from the cache,
 * decoded, and handled with one insert and two balance updates, and the result is flushed.
 *
 *   TIDEMARK_TEST_DATABASE_URL=... pnpm --filter @tidemark/bench run erc20
 *   TRANSFERS=200000 RECIPIENTS=5000 pnpm --filter @tidemark/bench run erc20
 */
import { cpus } from "node:os";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { createTidemark, defineConfig, runHistorical } from "@tidemark/engine";
import { connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { createTestDatabase, startAnvil } from "@tidemark/testing";
import { type Address, getAddress } from "viem";

const TRANSFERS = Number(process.env.TRANSFERS ?? 100_000);
const RECIPIENTS = Number(process.env.RECIPIENTS ?? 2_000);
const PER_TX = 500;

const account = onchainTable("account", { id: t.hex().primaryKey(), balance: t.bigint().notNull() });
const transfer = onchainTable("transfer", {
  id: t.text().primaryKey(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  value: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
});
const schema = { account, transfer };

const anvil = await startAnvil();
const db = await createTestDatabase();
const sql = connect(db.url, { max: 8 });
try {
  const deployed = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
  const token = (await anvil.publicClient.waitForTransactionReceipt({ hash: deployed }))
    .contractAddress as Address;
  const me = anvil.walletClient.account.address;
  await anvil.publicClient.waitForTransactionReceipt({
    hash: await anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "mint",
      args: [me, 10n ** 40n],
    }),
  });
  const recipients = Array.from({ length: RECIPIENTS }, (_, i) =>
    getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
  );

  const generating = performance.now();
  for (let sent = 0; sent < TRANSFERS; sent += PER_TX) {
    const n = Math.min(PER_TX, TRANSFERS - sent);
    const to = Array.from({ length: n }, (_, i) => recipients[(sent + i) % RECIPIENTS] as Address);
    const hash = await anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "batchTransfer",
      args: [to, to.map((_, i) => BigInt(i + 1))],
      gas: 30_000_000n,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash });
  }
  await anvil.testClient.mine({ blocks: 64 });
  const generateSeconds = (performance.now() - generating) / 1_000;

  const project = () => {
    const config = defineConfig({
      chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl } },
      contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
    });
    const tidemark = createTidemark(config);
    tidemark.on("Token:Transfer", async ({ event, context }) => {
      const { from, to, value } = event.args;
      await context.db.insert(transfer).values({
        id: `${event.transaction.hash}-${event.log.logIndex}`,
        from,
        to,
        value,
        blockNumber: event.block.number,
      });
      if (from !== "0x0000000000000000000000000000000000000000") {
        await context.db.update(account, { id: from }).set((row) => ({ balance: row.balance - value }));
      }
      await context.db
        .insert(account)
        .values({ id: to, balance: value })
        .onConflictDoUpdate((row) => ({ balance: row.balance + value }));
    });
    return tidemark;
  };

  const syncing = performance.now();
  const first = await runHistorical({ tidemark: project(), schema, sql, indexSchema: "bench_warm" });
  const syncSeconds = (performance.now() - syncing) / 1_000;

  const indexing = performance.now();
  const second = await runHistorical({ tidemark: project(), schema, sql, indexSchema: "bench_cached" });
  const indexSeconds = (performance.now() - indexing) / 1_000;
  const events = second.chains[0]?.events ?? 0;
  if (events !== first.chains[0]?.events || events < TRANSFERS)
    throw new Error(`expected ${TRANSFERS} events, got ${events}`);

  console.log(
    JSON.stringify({
      benchmark: "erc20-from-cache",
      events,
      eventsPerSecond: Math.round(events / indexSeconds),
      indexSeconds: Number(indexSeconds.toFixed(2)),
      firstRunWithSyncSeconds: Number(syncSeconds.toFixed(2)),
      generateSeconds: Number(generateSeconds.toFixed(2)),
      cpus: cpus().length,
      cpu: cpus()[0]?.model,
      node: process.version,
    }),
  );
} finally {
  await sql.end();
  await db.drop();
  await anvil.stop();
}
