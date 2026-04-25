/**
 * The core invariant: for any sequence of blocks, reorgs above finality,
 * crashes and restarts, the tables equal a from-scratch index of the final canonical chain.
 */
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { UnrecoverableReorgError } from "@tidemark/sync";
import { type Anvil, createTestDatabase, startAnvil } from "@tidemark/testing";
import fc from "fast-check";
import { type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { createTidemark, defineConfig, runHistorical, runIndexer } from "../src/index.js";

const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  transfers: t.integer().notNull(),
  lastBlock: t.bigint().notNull(),
});
const transfer = onchainTable("transfer", {
  id: t.text().primaryKey(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  value: t.bigint().notNull(),
  block: t.bigint().notNull(),
});
const schema = { account, transfer };
const ZERO = "0x0000000000000000000000000000000000000000";
const recipients = Array.from({ length: 6 }, (_, i) =>
  getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
);

function project(anvil: Anvil, token: Address, finality: "tag" | { depth: number }) {
  const config = defineConfig({
    chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality } },
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
      block: event.block.number,
    });
    if (from !== ZERO) {
      await context.db.update(account, { id: from }).set((row) => ({
        balance: row.balance - value,
        transfers: row.transfers + 1,
        lastBlock: event.block.number,
      }));
    }
    await context.db
      .insert(account)
      .values({ id: to, balance: value, transfers: 1, lastBlock: event.block.number })
      .onConflictDoUpdate((row) => ({
        balance: row.balance + value,
        transfers: row.transfers + 1,
        lastBlock: event.block.number,
      }));
  });
  return tidemark;
}

async function snapshot(sql: Sql, indexSchema: string) {
  const accounts = await sql.unsafe<{ id: Buffer; balance: string; transfers: number; last_block: string }[]>(
    `select id, balance::text, transfers, last_block::text from "${indexSchema}"."account" order by id`,
  );
  const transfers = await sql.unsafe<{ id: string; value: string; block: string }[]>(
    `select id, value::text, block::text from "${indexSchema}"."transfer" order by id`,
  );
  return { accounts: accounts.map((a) => ({ ...a, id: a.id.toString("hex") })), transfers };
}

/** A running realtime indexer, and how far it has got. */
function startIndexer(anvil: Anvil, token: Address, sql: Sql, indexSchema: string) {
  const controller = new AbortController();
  const state = { hash: "", number: -1, reorgs: 0, finalizations: 0 };
  const done = runIndexer({
    tidemark: project(anvil, token, "tag"),
    schema,
    sql,
    indexSchema,
    signal: controller.signal,
    realtime: {
      pollIntervalMs: 20,
      onEvent: (event) => {
        if (event.type === "block")
          Object.assign(state, { hash: event.block.header.hash, number: event.block.header.number });
        else if (event.type === "reorg") {
          state.reorgs++;
          Object.assign(state, { hash: event.ancestor.hash, number: event.ancestor.number });
        } else state.finalizations++;
      },
    },
  });
  // Surface failures through `done`; keep an unawaited rejection from crashing the run.
  done.catch(() => undefined);
  return {
    state,
    done,
    async caughtUp() {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const head = await anvil.publicClient.getBlock({ blockTag: "latest" });
        if (state.hash === head.hash) return;
        if (Date.now() > deadline) throw new Error(`indexer at ${state.number}, head at ${head.number}`);
        await Promise.race([done, new Promise((r) => setTimeout(r, 20))]);
      }
    },
    async stop() {
      controller.abort();
      await done;
    },
  };
}

type Op =
  | { op: "transfer"; to: number[]; amounts: bigint[] }
  | { op: "mine"; blocks: number }
  | { op: "reorg"; depth: number; refill: boolean; indexedFirst: boolean }
  | { op: "catchUp" }
  | { op: "restart" }
  | { op: "reorgWhileStopped"; depth: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .array(fc.tuple(fc.nat(recipients.length - 1), fc.bigInt({ min: 1n, max: 10n ** 18n })), {
        minLength: 1,
        maxLength: 5,
      })
      .map((xs) => ({ op: "transfer" as const, to: xs.map(([i]) => i), amounts: xs.map(([, a]) => a) })),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("mine" as const),
      blocks: fc.oneof(fc.integer({ min: 1, max: 3 }), fc.constant(40)),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant("reorg" as const),
      depth: fc.integer({ min: 1, max: 8 }),
      refill: fc.boolean(),
      // Mostly reorg blocks the indexer has already handled, so rollbacks really happen.
      indexedFirst: fc.oneof(
        { weight: 3, arbitrary: fc.constant(true) },
        { weight: 1, arbitrary: fc.constant(false) },
      ),
    }),
  },
  { weight: 3, arbitrary: fc.constant({ op: "catchUp" as const }) },
  { weight: 1, arbitrary: fc.constant({ op: "restart" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("reorgWhileStopped" as const),
      depth: fc.integer({ min: 1, max: 8 }),
    }),
  },
);

async function setup() {
  const anvil = await startAnvil();
  const hash = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
  const token = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  const me = anvil.walletClient.account.address;
  const minted = await anvil.publicClient.waitForTransactionReceipt({
    hash: await anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "mint",
      args: [me, 10n ** 30n],
    }),
  });
  // Headroom, so reorgs have blocks to replace above the mint, and close to Anvil's 64-block
  // finality window, so most runs see the finalised block move.
  await anvil.testClient.mine({ blocks: 60 });
  // Reorgs in the tests must not rewrite the deployment or the mint: everything else would revert.
  return { anvil, token, floor: Number(minted.blockNumber) };
}

describe("realtime indexing through reorgs", () => {
  it("equals a from-scratch index of the final chain, whatever reorgs, restarts and finality did", async () => {
    let reorgsSeen = 0;
    let finalizations = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 4, maxLength: 22 }), async (ops) => {
        const { anvil, token, floor } = await setup();
        const db = await createTestDatabase();
        const sql = connect(db.url, { max: 6 });
        let indexer = startIndexer(anvil, token, sql, "live");
        try {
          await indexer.caughtUp();
          const send = async (to: number[], amounts: bigint[]) => {
            const h = await anvil.walletClient.writeContract({
              address: token,
              abi: tokenAbi,
              functionName: "batchTransfer",
              args: [to.map((i) => recipients[i] as Address), amounts],
            });
            await anvil.publicClient.waitForTransactionReceipt({ hash: h });
          };
          for (const o of ops) {
            const head = Number(await anvil.publicClient.getBlockNumber());
            switch (o.op) {
              case "transfer":
                await send(o.to, o.amounts);
                break;
              case "mine":
                await anvil.testClient.mine({ blocks: o.blocks });
                break;
              case "reorg":
                if (o.indexedFirst) await indexer.caughtUp();
                // Stay above Anvil's finalised block (head - 64) and above the mint.
                if (head - o.depth > floor) {
                  await anvil.reorg(o.depth);
                  if (o.refill) await send([0, 1], [7n, 9n]);
                }
                break;
              case "catchUp":
                await indexer.caughtUp();
                break;
              case "restart":
                await indexer.stop();
                reorgsSeen += indexer.state.reorgs;
                indexer = startIndexer(anvil, token, sql, "live");
                break;
              case "reorgWhileStopped":
                await indexer.stop();
                reorgsSeen += indexer.state.reorgs;
                if (head - o.depth > floor) await anvil.reorg(o.depth);
                indexer = startIndexer(anvil, token, sql, "live");
                break;
            }
          }
          await anvil.testClient.mine({ blocks: 1 });
          await indexer.caughtUp();
          reorgsSeen += indexer.state.reorgs;
          finalizations += indexer.state.finalizations;
          await indexer.stop();

          // The reference: index the final chain from scratch, treating the head as final, in a
          // separate database so its cache cannot share anything with the live one.
          const refDb = await createTestDatabase();
          const refSql = connect(refDb.url, { max: 4 });
          try {
            await runHistorical({
              tidemark: project(anvil, token, { depth: 0 }),
              schema,
              sql: refSql,
              indexSchema: "ref",
            });
            expect(await snapshot(sql, "live")).toEqual(await snapshot(refSql, "ref"));
          } finally {
            await refSql.end();
            await refDb.drop();
          }
        } finally {
          await indexer.stop().catch(() => undefined);
          await sql.end();
          await db.drop();
          await anvil.stop();
        }
      }),
      { numRuns: 12 },
    );
    // The test must actually exercise rollbacks and finality, not just pass by luck.
    expect(reorgsSeen).toBeGreaterThan(5);
    expect(finalizations).toBeGreaterThan(0);
  }, 900_000);

  it("halts on a reorg below the finalised block and keeps the indexed state", async () => {
    const { anvil, token } = await setup();
    const db = await createTestDatabase();
    const sql = connect(db.url, { max: 4 });
    try {
      for (let i = 0; i < 3; i++) {
        await anvil.publicClient.waitForTransactionReceipt({
          hash: await anvil.walletClient.writeContract({
            address: token,
            abi: tokenAbi,
            functionName: "batchTransfer",
            args: [[recipients[0] as Address], [1n]],
          }),
        });
      }
      await anvil.testClient.mine({ blocks: 80 });
      const indexer = startIndexer(anvil, token, sql, "live");
      await indexer.caughtUp();
      const before = await snapshot(sql, "live");
      await anvil.reorg(75); // Anvil finalises head - 64: this rewrites finalised blocks
      await expect(indexer.done).rejects.toBeInstanceOf(UnrecoverableReorgError);
      expect(await snapshot(sql, "live")).toEqual(before);
    } finally {
      await sql.end();
      await db.drop();
      await anvil.stop();
    }
  }, 120_000);
});
