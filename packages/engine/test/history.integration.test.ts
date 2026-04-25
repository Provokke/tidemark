/**
 * History tables: through any sequence of blocks, reorgs and restarts,
 * (1) the history table equals the history of a from-scratch index of the final chain, version for
 * version, and (2) reading the tables at any block that is still canonical (GraphQL `at`, SQL
 * `<table>_at`) gives exactly what the live table held when that block was the head.
 */
import { createApi } from "@tidemark/api";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { type Anvil, createTestDatabase, startAnvil } from "@tidemark/testing";
import fc from "fast-check";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import { createTidemark, defineConfig, runHistorical, runIndexer } from "../src/index.js";

const account = onchainTable(
  "account",
  { id: t.hex().primaryKey(), balance: t.bigint().notNull(), transfers: t.integer().notNull() },
  undefined,
  { history: true },
);
const schema = { account };
const ZERO = "0x0000000000000000000000000000000000000000";
const recipients = Array.from({ length: 4 }, (_, i) =>
  getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
);

function project(anvil: Anvil, token: Address, finality: "tag" | { depth: number }) {
  const tidemark = createTidemark(
    defineConfig({
      chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality } },
      contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
    }),
  );
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    const { from, to, value } = event.args;
    if (from !== ZERO) {
      // Delete an emptied account, so history also records deletions.
      const row = await context.db.find(account, { id: from });
      if (row !== null && row.balance === value) await context.db.delete(account, { id: from });
      else
        await context.db
          .update(account, { id: from })
          .set((r) => ({ balance: r.balance - value, transfers: r.transfers + 1 }));
    }
    await context.db
      .insert(account)
      .values({ id: to, balance: value, transfers: 1 })
      .onConflictDoUpdate((r) => ({ balance: r.balance + value, transfers: r.transfers + 1 }));
  });
  return tidemark;
}

const dumpHistory = (sql: Sql, schemaName: string) =>
  sql.unsafe<Record<string, string>[]>(
    `select encode(id, 'hex') as id, balance::text, transfers::text, tm_valid_from, coalesce(tm_valid_to, '') as tm_valid_to
     from "${schemaName}"."_tm_history_account" order by id, tm_valid_from`,
  );
const dumpLive = async (sql: Sql, schemaName: string) =>
  (
    await sql.unsafe<{ id: string; balance: string; transfers: number }[]>(
      `select '0x' || encode(id, 'hex') as id, balance::text, transfers from "${schemaName}"."account" order by id`,
    )
  ).map((r) => ({ id: r.id, balance: r.balance, transfers: r.transfers }));

type Op =
  | { op: "transfer"; to: number[]; amounts: bigint[] }
  | { op: "drain"; who: number }
  | { op: "mine"; blocks: number }
  | { op: "reorg"; depth: number }
  | { op: "snapshot" }
  | { op: "restart" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .array(fc.tuple(fc.nat(recipients.length - 1), fc.bigInt({ min: 1n, max: 1000n })), {
        minLength: 1,
        maxLength: 3,
      })
      .map((xs) => ({ op: "transfer" as const, to: xs.map(([i]) => i), amounts: xs.map(([, a]) => a) })),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant("drain" as const), who: fc.nat(recipients.length - 1) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant("mine" as const), blocks: fc.integer({ min: 1, max: 3 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant("reorg" as const), depth: fc.integer({ min: 1, max: 4 }) }),
  },
  { weight: 4, arbitrary: fc.constant({ op: "snapshot" as const }) },
  { weight: 1, arbitrary: fc.constant({ op: "restart" as const }) },
);

it("keeps history equal to a from-scratch index, and time travel exact, through reorgs and restarts", async () => {
  let reorgs = 0;
  let checkedPoints = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { minLength: 5, maxLength: 18 }), async (ops) => {
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
      // Room for reorgs above the mint, still inside Anvil's 64-block finality window.
      await anvil.testClient.mine({ blocks: 20 });
      const floor = Number(minted.blockNumber) + 1;
      const db = await createTestDatabase();
      const sql = connect(db.url, { max: 6 });

      const start = () => {
        const controller = new AbortController();
        const state = { hash: "", reorgs: 0 };
        const done = runIndexer({
          tidemark: project(anvil, token, "tag"),
          schema,
          sql,
          indexSchema: "live",
          signal: controller.signal,
          realtime: {
            pollIntervalMs: 20,
            onEvent: (e) => {
              if (e.type === "block") state.hash = e.block.header.hash;
              else if (e.type === "reorg") {
                state.reorgs++;
                state.hash = e.ancestor.hash;
              }
            },
          },
        });
        done.catch(() => undefined);
        return {
          state,
          async caughtUp() {
            const deadline = Date.now() + 30_000;
            for (;;) {
              const head = await anvil.publicClient.getBlock({ blockTag: "latest" });
              if (state.hash === head.hash) return head;
              if (Date.now() > deadline) throw new Error("indexer did not catch up");
              await Promise.race([done, new Promise((r) => setTimeout(r, 20))]);
            }
          },
          async stop() {
            controller.abort();
            await done;
            reorgs += state.reorgs;
          },
        };
      };

      const snapshots: { number: bigint; hash: string; rows: Awaited<ReturnType<typeof dumpLive>> }[] = [];
      let indexer = start();
      try {
        const send = async (to: number[], amounts: bigint[], from?: number) => {
          const h = await anvil.walletClient.writeContract(
            from === undefined
              ? {
                  address: token,
                  abi: tokenAbi,
                  functionName: "batchTransfer",
                  args: [to.map((i) => recipients[i] as Address), amounts],
                }
              : { address: token, abi: tokenAbi, functionName: "transfer", args: [me, 0n] },
          );
          await anvil.publicClient.waitForTransactionReceipt({ hash: h });
        };
        for (const o of ops) {
          const head = Number(await anvil.publicClient.getBlockNumber());
          switch (o.op) {
            case "transfer":
              await send(o.to, o.amounts);
              break;
            case "drain": {
              // Send a recipient's whole balance back, so its row is deleted (and its history closed).
              const who = recipients[o.who] as Address;
              const balance = await anvil.publicClient.readContract({
                address: token,
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [who],
              });
              if (balance > 0n) {
                await anvil.testClient.impersonateAccount({ address: who });
                await anvil.testClient.setBalance({ address: who, value: 10n ** 18n });
                const h = await anvil.walletClient.writeContract({
                  account: who,
                  address: token,
                  abi: tokenAbi,
                  functionName: "transfer",
                  args: [me, balance],
                });
                await anvil.publicClient.waitForTransactionReceipt({ hash: h });
                await anvil.testClient.stopImpersonatingAccount({ address: who });
              }
              break;
            }
            case "mine":
              await anvil.testClient.mine({ blocks: o.blocks });
              break;
            case "reorg":
              if (head - o.depth > floor) {
                await indexer.caughtUp();
                await anvil.reorg(o.depth);
              }
              break;
            case "snapshot": {
              const at = await indexer.caughtUp();
              snapshots.push({ number: at.number, hash: at.hash, rows: await dumpLive(sql, "live") });
              break;
            }
            case "restart":
              await indexer.stop();
              indexer = start();
              break;
          }
        }
        await anvil.testClient.mine({ blocks: 1 });
        await indexer.caughtUp();
        snapshots.push({ ...(await indexer.caughtUp()), rows: await dumpLive(sql, "live") } as never);
        await indexer.stop();

        // (1) History equals a from-scratch index of the final chain.
        const refDb = await createTestDatabase();
        const refSql = connect(refDb.url, { max: 4 });
        try {
          await runHistorical({
            tidemark: project(anvil, token, { depth: 0 }),
            schema,
            sql: refSql,
            indexSchema: "ref",
          });
          expect(await dumpHistory(sql, "live")).toEqual(await dumpHistory(refSql, "ref"));
        } finally {
          await refSql.end();
          await refDb.drop();
        }

        // (2) Reads at every snapshot block still on the chain give what the table held then.
        const api = createApi({ sql, schema, databaseSchema: "live" });
        try {
          for (const snap of snapshots) {
            const now = await anvil.publicClient.getBlock({ blockNumber: snap.number });
            if (now.hash !== snap.hash) continue; // reorged away since
            const res = await api.app.request("/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query:
                  "query($b: String!) { accounts(at: { block: $b }, orderBy: [{ id: ASC }], first: 100) { nodes { id balance transfers } } }",
                variables: { b: snap.number.toString() },
              }),
            });
            const body = (await res.json()) as {
              data?: { accounts: { nodes: unknown[] } };
              errors?: unknown;
            };
            expect(body.errors).toBeUndefined();
            expect(body.data?.accounts.nodes).toEqual(snap.rows);
            const viaSql = await api.app.request("/sql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query:
                  "select '0x' || encode(id, 'hex') as id, balance::text as balance, transfers from account_at(tm_checkpoint_at(31337, $1)) order by id",
                params: [snap.number.toString()],
              }),
            });
            const sqlBody = (await viaSql.json()) as { rows?: unknown[][]; error?: string };
            expect(sqlBody.error).toBeUndefined();
            expect(sqlBody.rows).toEqual(snap.rows.map((r) => [r.id, r.balance, r.transfers]));
            checkedPoints++;
          }
        } finally {
          await api.close();
        }
      } finally {
        await indexer.stop().catch(() => undefined);
        await sql.end();
        await db.drop();
        await anvil.stop();
      }
    }),
    { numRuns: Number(process.env.HISTORY_RUNS ?? 8) },
  );
  expect(reorgs).toBeGreaterThan(2);
  expect(checkedPoints).toBeGreaterThan(10);
}, 900_000);
