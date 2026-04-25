/**
 * Omnichain ordering: handlers on two chains write one shared counter, so the result exposes the
 * exact order events ran in. Historical must follow (timestamp, chain id, block, log index); realtime
 * must reach the same result as a from-scratch omnichain index, through reorgs on either chain.
 */
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { type Anvil, createTestDatabase, startAnvil } from "@tidemark/testing";
import fc from "fast-check";
import { type Address, getAddress, parseEventLogs } from "viem";
import { describe, expect, it } from "vitest";
import { createTidemark, defineConfig, runHistorical, runIndexer } from "../src/index.js";

const counter = onchainTable("counter", { id: t.integer().primaryKey(), value: t.integer().notNull() });
const entry = onchainTable("entry", {
  id: t.text().primaryKey(),
  seq: t.integer().notNull(),
  chainId: t.integer().notNull(),
  block: t.bigint().notNull(),
});
const schema = { counter, entry };

interface World {
  a: Anvil;
  b: Anvil;
  tokenA: Address;
  tokenB: Address;
  /** One clock for both chains, so their blocks interleave in time. */
  clock: number;
}

async function setup(): Promise<World> {
  const a = await startAnvil({ chainId: 31_337 });
  const b = await startAnvil({ chainId: 31_338 });
  const world: World = { a, b, tokenA: "0x" as Address, tokenB: "0x" as Address, clock: 2_000_000_000 };
  for (const [anvil, key] of [
    [a, "tokenA"],
    [b, "tokenB"],
  ] as const) {
    await anvil.testClient.setNextBlockTimestamp({ timestamp: BigInt(world.clock++) });
    const hash = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
    world[key] = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
    await anvil.testClient.setNextBlockTimestamp({ timestamp: BigInt(world.clock++) });
    const mint = await anvil.walletClient.writeContract({
      address: world[key],
      abi: tokenAbi,
      functionName: "mint",
      args: [anvil.walletClient.account.address, 10n ** 30n],
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: mint });
  }
  for (const anvil of [a, b]) {
    for (let i = 0; i < 4; i++) {
      await anvil.testClient.setNextBlockTimestamp({ timestamp: BigInt(world.clock++) });
      await anvil.testClient.mine({ blocks: 1 });
    }
  }
  return world;
}

async function transfer(world: World, onB: boolean, n: number) {
  const anvil = onB ? world.b : world.a;
  await anvil.testClient.setNextBlockTimestamp({ timestamp: BigInt(world.clock++) });
  const hash = await anvil.walletClient.writeContract({
    address: onB ? world.tokenB : world.tokenA,
    abi: tokenAbi,
    functionName: "batchTransfer",
    args: [
      Array.from({ length: n }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`)),
      Array.from({ length: n }, () => 1n),
    ],
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash });
}

/**
 * One block on each chain, the higher chain id first. With strictly increasing timestamps, every
 * block then has a later block on the other chain, so omnichain realtime can run all of them.
 */
async function mineBoth(world: World) {
  for (const anvil of [world.b, world.a]) {
    await anvil.testClient.setNextBlockTimestamp({ timestamp: BigInt(world.clock++) });
    await anvil.testClient.mine({ blocks: 1 });
  }
}

function project(world: World, finality: "tag" | { depth: number }) {
  const config = defineConfig({
    chains: {
      a: { id: 31_337, rpc: world.a.rpcUrl, finality, strictTimestamps: true },
      b: { id: 31_338, rpc: world.b.rpcUrl, finality, strictTimestamps: true },
    },
    contracts: {
      TokenA: { chain: "a", abi: tokenAbi, address: world.tokenA, startBlock: 0 },
      TokenB: { chain: "b", abi: tokenAbi, address: world.tokenB, startBlock: 0 },
    },
    ordering: "omnichain",
  });
  const tidemark = createTidemark(config);
  const handler = async ({
    event,
    context,
  }: {
    event: { transaction: { hash: string }; log: { logIndex: number }; block: { number: bigint } };
    context: { db: any; chain: { id: number } };
  }) => {
    const row = await context.db
      .insert(counter)
      .values({ id: 1, value: 1 })
      .onConflictDoUpdate((r: { value: number }) => ({ value: r.value + 1 }))
      .then(() => context.db.find(counter, { id: 1 }));
    await context.db.insert(entry).values({
      id: `${context.chain.id}-${event.transaction.hash}-${event.log.logIndex}`,
      seq: row.value,
      chainId: context.chain.id,
      block: event.block.number,
    });
  };
  tidemark.on("TokenA:Transfer", handler as never);
  tidemark.on("TokenB:Transfer", handler as never);
  return tidemark;
}

const entries = async (sql: Sql, s: string) =>
  (await sql.unsafe(`select id, seq, chain_id from "${s}".entry order by seq`)).map(
    (r) => `${r.seq as number}:${r.id as string}`,
  );

describe("omnichain ordering", () => {
  it("historical: runs events from both chains in (timestamp, chain, block, log) order", async () => {
    const world = await setup();
    const db = await createTestDatabase();
    const sql = connect(db.url);
    try {
      for (let i = 0; i < 12; i++) await transfer(world, i % 3 === 0, 1 + (i % 4));
      await mineBoth(world);
      await runHistorical({
        tidemark: project(world, { depth: 0 }),
        schema,
        sql,
        indexSchema: "omni",
        maxBatchBlocks: 3,
        flushEveryRows: 5,
      });

      // The reference order, computed from both chains directly.
      const logs = [];
      for (const [anvil, address, chainId] of [
        [world.a, world.tokenA, 31_337],
        [world.b, world.tokenB, 31_338],
      ] as const) {
        for (const l of parseEventLogs({
          abi: tokenAbi,
          eventName: "Transfer",
          logs: await anvil.publicClient.getLogs({ address, fromBlock: 0n }),
        })) {
          const block = await anvil.publicClient.getBlock({ blockNumber: l.blockNumber });
          logs.push({
            key: [block.timestamp, chainId, l.blockNumber, l.logIndex] as const,
            id: `${chainId}-${l.transactionHash}-${l.logIndex}`,
          });
        }
      }
      logs.sort((x, y) => {
        for (let i = 0; i < 4; i++) {
          const [p, q] = [BigInt(x.key[i] as number | bigint), BigInt(y.key[i] as number | bigint)];
          if (p !== q) return p < q ? -1 : 1;
        }
        return 0;
      });
      expect(await entries(sql, "omni")).toEqual(logs.map((l, i) => `${i + 1}:${l.id}`));
      // The interleaving is real: the sequence switches chains more than once.
      const chains = logs.map((l) => l.id.split("-")[0]);
      expect(chains.filter((c, i) => i > 0 && c !== chains[i - 1]).length).toBeGreaterThan(3);
    } finally {
      await sql.end();
      await db.drop();
      await world.a.stop();
      await world.b.stop();
    }
  }, 120_000);

  it("realtime: equals a from-scratch omnichain index, whatever reorgs and restarts did on either chain", async () => {
    let reorgs = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            {
              weight: 4,
              arbitrary: fc.record({
                op: fc.constant("transfer" as const),
                onB: fc.boolean(),
                n: fc.integer({ min: 1, max: 3 }),
              }),
            },
            {
              weight: 2,
              arbitrary: fc.record({
                op: fc.constant("reorg" as const),
                onB: fc.boolean(),
                depth: fc.integer({ min: 1, max: 3 }),
              }),
            },
            { weight: 2, arbitrary: fc.constant({ op: "catchUp" as const }) },
            { weight: 1, arbitrary: fc.constant({ op: "restart" as const }) },
          ),
          { minLength: 4, maxLength: 14 },
        ),
        async (ops) => {
          const world = await setup();
          const db = await createTestDatabase();
          const sql = connect(db.url, { max: 6 });
          const start = () => {
            const controller = new AbortController();
            const seen = { a: "", b: "", reorgs: 0 };
            const done = runIndexer({
              tidemark: project(world, "tag"),
              schema,
              sql,
              indexSchema: "live",
              signal: controller.signal,
              realtime: {
                pollIntervalMs: 20,
                onEvent: (e) => {
                  const key = e.chainId === 31_337 ? "a" : "b";
                  if (e.type === "block") seen[key] = e.block.header.hash;
                  else if (e.type === "reorg") {
                    seen[key] = e.ancestor.hash;
                    seen.reorgs++;
                  }
                },
              },
            });
            done.catch(() => undefined);
            return { controller, seen, done };
          };
          let indexer = start();
          const caughtUp = async () => {
            // Both chains must pass every pending block's time before omnichain can run it.
            await mineBoth(world);
            const deadline = Date.now() + 30_000;
            for (;;) {
              const [ha, hb] = [await world.a.publicClient.getBlock(), await world.b.publicClient.getBlock()];
              if (indexer.seen.a === ha.hash && indexer.seen.b === hb.hash) return;
              if (Date.now() > deadline) throw new Error("omnichain indexer did not catch up");
              await Promise.race([indexer.done, new Promise((r) => setTimeout(r, 20))]);
            }
          };
          try {
            await caughtUp();
            for (const o of ops) {
              if (o.op === "transfer") await transfer(world, o.onB, o.n);
              else if (o.op === "catchUp") await caughtUp();
              else if (o.op === "restart") {
                indexer.controller.abort();
                await indexer.done;
                reorgs += indexer.seen.reorgs;
                indexer = start();
              } else {
                await caughtUp();
                const anvil = o.onB ? world.b : world.a;
                const head = Number(await anvil.publicClient.getBlockNumber());
                if (head - o.depth > 6) await anvil.reorg(o.depth);
              }
            }
            await caughtUp();
            reorgs += indexer.seen.reorgs;
          } finally {
            indexer.controller.abort();
            await indexer.done;
          }
          const refDb = await createTestDatabase();
          const refSql = connect(refDb.url);
          try {
            await runHistorical({
              tidemark: project(world, { depth: 0 }),
              schema,
              sql: refSql,
              indexSchema: "ref",
            });
            expect(await entries(sql, "live")).toEqual(await entries(refSql, "ref"));
          } finally {
            await refSql.end();
            await refDb.drop();
            await sql.end();
            await db.drop();
            await world.a.stop();
            await world.b.stop();
          }
        },
      ),
      {
        numRuns: Number(process.env.OMNI_RUNS ?? 10),
        examples: [
          // A restart with both chains above finality, after the shared counter changed on each:
          // rolling the chains back one at a time left it one too high.
          [
            [
              { op: "transfer", onB: false, n: 2 },
              { op: "reorg", onB: false, depth: 2 },
              { op: "transfer", onB: true, n: 1 },
              { op: "restart" },
            ],
          ],
        ],
        // Replay a counterexample: OMNI_SEED and OMNI_PATH from a failure report.
        ...(process.env.OMNI_SEED === undefined
          ? {}
          : {
              seed: Number(process.env.OMNI_SEED),
              endOnFailure: true,
              ...(process.env.OMNI_PATH === undefined ? {} : { path: process.env.OMNI_PATH }),
            }),
      },
    );
    // Across many runs reorgs must really have happened; a single replayed case proves nothing either way.
    if (process.env.OMNI_SEED === undefined) expect(reorgs).toBeGreaterThan(2);
  }, 900_000);
});
