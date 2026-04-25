import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { type Sql, connect } from "@tidemark/pg";
import { RpcPool } from "@tidemark/rpc";
import { onchainTable, t } from "@tidemark/schema";
import { type Anvil, type TestDatabase, createTestDatabase, startAnvil } from "@tidemark/testing";
import fc from "fast-check";
import { type Address, getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { HandlerError, createTidemark, defineConfig, runHistorical } from "../src/index.js";

const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  transfers: t.integer().notNull().default(0),
});
const transfer = onchainTable("transfer", {
  id: t.text().primaryKey(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  value: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.timestamp().notNull(),
});
const schema = { account, transfer };

let anvil: Anvil;
let token: Address;
let holders: Address[];
let db: TestDatabase;
let sql: Sql;

const ZERO = "0x0000000000000000000000000000000000000000";

function project(options: { failAt?: { count: number; remaining: number } } = {}) {
  const config = defineConfig({
    chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, maxLogRange: 50 } },
    contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
  });
  const tidemark = createTidemark(config);
  let seen = 0;
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    expectTypeOf(event.args.value).toEqualTypeOf<bigint>();
    expectTypeOf(event.args.from).toEqualTypeOf<`0x${string}`>();
    const fail = options.failAt;
    if (fail !== undefined && fail.remaining > 0 && ++seen === fail.count) {
      fail.remaining--;
      throw new Error("injected handler crash");
    }
    const { from, to, value } = event.args;
    await context.db.insert(transfer).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      from,
      to,
      value,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    });
    if (from !== ZERO) {
      await context.db
        .update(account, { id: from })
        .set((row) => ({ balance: row.balance - value, transfers: row.transfers + 1 }));
    }
    await context.db
      .insert(account)
      .values({ id: to, balance: value, transfers: 1 })
      .onConflictDoUpdate((row) => ({ balance: row.balance + value, transfers: row.transfers + 1 }));
  });
  return tidemark;
}

beforeAll(async () => {
  anvil = await startAnvil();
  db = await createTestDatabase();
  sql = connect(db.url, { max: 6 });
  const hash = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
  token = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  holders = Array.from({ length: 25 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
  const me = anvil.walletClient.account.address;
  const send = async (tx: Promise<`0x${string}`>) =>
    anvil.publicClient.waitForTransactionReceipt({ hash: await tx });

  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "mint",
      args: [me, 10n ** 30n],
    }),
  );
  const plan = fc.sample(
    fc.array(fc.tuple(fc.nat(holders.length - 1), fc.bigInt({ min: 1n, max: 10n ** 20n })), {
      minLength: 1,
      maxLength: 30,
    }),
    { numRuns: 40, seed: 7 },
  );
  for (const [i, batch] of plan.entries()) {
    await send(
      anvil.walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: "batchTransfer",
        args: [batch.map(([h]) => holders[h] as Address), batch.map(([, v]) => v)],
      }),
    );
    if (i % 5 === 0) await anvil.testClient.mine({ blocks: 3 });
  }
  // transferFrom through an allowance, so Transfer comes from a spender's call too.
  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "approve",
      args: [me, 10n ** 18n],
    }),
  );
  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "transferFrom",
      args: [me, holders[0] as Address, 5n],
    }),
  );
  await anvil.testClient.mine({ blocks: 64 });
}, 120_000);

afterAll(async () => {
  await sql.end();
  await db.drop();
  await anvil.stop();
});

async function snapshot(indexSchema: string) {
  const accounts = await sql.unsafe<{ id: Buffer; balance: string; transfers: number }[]>(
    `select id, balance::text, transfers from "${indexSchema}"."account" order by id`,
  );
  const [count] = await sql.unsafe<{ n: bigint }[]>(
    `select count(*)::int8 as n from "${indexSchema}"."transfer"`,
  );
  return {
    accounts: accounts.map((a) => [a.id.toString("hex"), a.balance, a.transfers]),
    transfers: count?.n,
  };
}

describe("historical indexing of an ERC-20", () => {
  it("indexes every transfer and ends with the balances the contract reports", async () => {
    const result = await runHistorical({ tidemark: project(), schema, sql, indexSchema: "erc20_clean" });
    const [chain] = result.chains;
    expect(chain?.complete).toBe(true);

    const finalized = Number((await anvil.publicClient.getBlock({ blockTag: "finalized" })).number);
    expect(chain?.processedBlock).toBe(finalized);
    const onChainLogs = await anvil.publicClient.getContractEvents({
      address: token,
      abi: tokenAbi,
      eventName: "Transfer",
      fromBlock: 0n,
      toBlock: BigInt(finalized),
    });
    expect(chain?.events).toBe(onChainLogs.length);

    const me = anvil.walletClient.account.address;
    for (const holder of [...holders, me]) {
      const expected = await anvil.publicClient.readContract({
        address: token,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [holder],
        blockNumber: BigInt(finalized),
      });
      const [row] = await sql.unsafe<{ balance: string }[]>(
        `select balance::text from "erc20_clean"."account" where id = $1`,
        [Buffer.from(holder.slice(2), "hex")],
      );
      expect(BigInt(row?.balance ?? "0")).toBe(expected);
    }
    // A second run finds nothing new to do and changes nothing.
    const before = await snapshot("erc20_clean");
    const again = await runHistorical({ tidemark: project(), schema, sql, indexSchema: "erc20_clean" });
    expect(again.chains[0]?.events).toBe(0);
    expect(await snapshot("erc20_clean")).toEqual(before);
  });

  it("reaches the same state after crashes in handlers and in commits, at any point", async () => {
    const reference = await snapshot("erc20_clean");
    let run = 0;
    let crashed = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("handler" as const), at: fc.integer({ min: 1, max: 300 }) }),
            fc.record({ kind: fc.constant("commit" as const), at: fc.integer({ min: 1, max: 6 }) }),
          ),
          { minLength: 1, maxLength: 4 },
        ),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 12 }),
        async (crashes, flushEveryRows, maxBatchBlocks) => {
          const indexSchema = `erc20_crash_${run++}`;
          for (const crash of crashes) {
            let commits = 0;
            const failAt = crash.kind === "handler" ? { count: crash.at, remaining: 1 } : undefined;
            await runHistorical({
              tidemark: project(failAt === undefined ? {} : { failAt }),
              schema,
              sql,
              indexSchema,
              flushEveryRows,
              maxBatchBlocks,
              beforeCommit: () =>
                crash.kind === "commit" && ++commits === crash.at
                  ? Promise.reject(new Error("injected commit failure"))
                  : Promise.resolve(),
            }).then(
              () => undefined,
              (error: unknown) => {
                crashed++;
                const message = error instanceof Error ? error.message : String(error);
                expect(message).toMatch(/injected/);
                if (crash.kind === "handler") expect(error).toBeInstanceOf(HandlerError);
              },
            );
          }
          const final = await runHistorical({
            tidemark: project(),
            schema,
            sql,
            indexSchema,
            flushEveryRows,
            maxBatchBlocks,
          });
          expect(final.chains[0]?.complete).toBe(true);
          expect(await snapshot(indexSchema)).toEqual(reference);
          await sql.unsafe(`drop schema "${indexSchema}" cascade`);
        },
      ),
      { numRuns: 25 },
    );
    // Guard against a test that stops crashing anything: most generated crash points must fire.
    expect(crashed).toBeGreaterThan(15);
  }, 300_000);

  it("refuses to resume into a schema made from different tables", async () => {
    const other = { account: onchainTable("account", { id: t.hex().primaryKey(), balance: t.bigint() }) };
    await expect(
      runHistorical({ tidemark: project(), schema: other, sql, indexSchema: "erc20_clean" }),
    ).rejects.toThrow(/different table definitions/);
  });

  it("indexes through flaky endpoints with the same result", async () => {
    const { startRpcProxy } = await import("@tidemark/testing");
    const flaky = await startRpcProxy({
      target: anvil.rpcUrl,
      faults: { failRate: 0.2, maxLogRange: 7 },
      seed: 3,
    });
    try {
      // A fresh database, so nothing is cached and everything goes through the proxy.
      const fresh = await createTestDatabase();
      const freshSql = connect(fresh.url);
      try {
        await runHistorical({
          tidemark: project(),
          schema,
          sql: freshSql,
          indexSchema: "erc20_flaky",
          createPool: (_, chainId) =>
            new RpcPool({ chainId, endpoints: [flaky.url, anvil.rpcUrl], sleep: () => Promise.resolve() }),
        });
        const rows = await freshSql.unsafe<{ id: Buffer; balance: string; transfers: number }[]>(
          `select id, balance::text, transfers from "erc20_flaky"."account" order by id`,
        );
        expect(rows.map((a) => [a.id.toString("hex"), a.balance, a.transfers])).toEqual(
          (await snapshot("erc20_clean")).accounts,
        );
      } finally {
        await freshSql.end();
        await fresh.drop();
      }
    } finally {
      await flaky.stop();
    }
  });
});
