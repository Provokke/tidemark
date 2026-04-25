/**
 * A redeploy re-indexes from the sync cache with
 * no historical RPC calls, and the API serves without errors across the cutover and a rollback.
 */
import { createLiveApi } from "@tidemark/api";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { createTestDatabase, startAnvil, startRpcProxy } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  type BuildResult,
  buildSchemaName,
  createTidemark,
  cutover,
  defineConfig,
  getBuild,
  listBuilds,
  liveState,
  pruneBuilds,
  rollback,
  runBuild,
} from "../src/index.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const recipients = Array.from({ length: 4 }, (_, i) =>
  getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
);

// Build A: balances.
const accountA = onchainTable("account", { id: t.hex().primaryKey(), balance: t.bigint().notNull() });
// Build B: the same table with a transfer count. A changed schema and handler means a new build.
const accountB = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  transfers: t.integer().notNull(),
});

function projectA(rpc: string, token: Address) {
  const tidemark = createTidemark(
    defineConfig({
      chains: { anvil: { id: 31_337, rpc, finality: "tag" } },
      contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
    }),
  );
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    const { from, to, value } = event.args;
    if (from !== ZERO)
      await context.db.update(accountA, { id: from }).set((r) => ({ balance: r.balance - value }));
    await context.db
      .insert(accountA)
      .values({ id: to, balance: value })
      .onConflictDoUpdate((r) => ({ balance: r.balance + value }));
  });
  return tidemark;
}

function projectB(rpc: string, token: Address) {
  const tidemark = createTidemark(
    defineConfig({
      chains: { anvil: { id: 31_337, rpc, finality: "tag" } },
      contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
    }),
  );
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    const { from, to, value } = event.args;
    if (from !== ZERO) {
      await context.db
        .update(accountB, { id: from })
        .set((r) => ({ balance: r.balance - value, transfers: r.transfers + 1 }));
    }
    await context.db
      .insert(accountB)
      .values({ id: to, balance: value, transfers: 1 })
      .onConflictDoUpdate((r) => ({ balance: r.balance + value, transfers: r.transfers + 1 }));
  });
  return tidemark;
}

describe("redeploys", () => {
  it("re-indexes from the cache and keeps serving across cutover and rollback", async () => {
    const anvil = await startAnvil();
    const db = await createTestDatabase();
    const sql = connect(db.url, { max: 12 });
    let rangedGetLogs = 0;
    let counting = false;
    const proxy = await startRpcProxy({
      target: anvil.rpcUrl,
      onCall: (method, params) => {
        const filter = params[0] as { fromBlock?: string } | undefined;
        if (counting && method === "eth_getLogs" && filter?.fromBlock !== undefined) rangedGetLogs++;
      },
    });
    const aborts: AbortController[] = [];
    const runs: Promise<BuildResult>[] = [];
    try {
      const deployed = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
      const token = (await anvil.publicClient.waitForTransactionReceipt({ hash: deployed }))
        .contractAddress as Address;
      const me = anvil.walletClient.account.address;
      const send = async (functionName: "mint" | "transfer", to: Address, amount: bigint) => {
        await anvil.publicClient.waitForTransactionReceipt({
          hash: await anvil.walletClient.writeContract({
            address: token,
            abi: tokenAbi,
            functionName,
            args: [to, amount],
          }),
        });
      };
      await send("mint", me, 10n ** 24n);
      for (const [i, to] of recipients.entries()) await send("transfer", to, BigInt(i + 1) * 1000n);
      await anvil.testClient.mine({ blocks: 64 });

      const start = (
        tidemark: ReturnType<typeof projectA>,
        schema: Record<string, unknown>,
        promote: "if-none" | "never",
      ) => {
        const controller = new AbortController();
        aborts.push(controller);
        let resolveReady: (id: string) => void = () => undefined;
        const ready = new Promise<string>((resolve) => (resolveReady = resolve));
        const done = runBuild({
          tidemark,
          schema,
          sql,
          signal: controller.signal,
          promote,
          realtime: { pollIntervalMs: 50 },
          onBuild: (e) => {
            if (e.status === (promote === "never" ? "ready" : "active")) resolveReady(e.buildId);
          },
        });
        done.catch(() => undefined);
        runs.push(done);
        return {
          ready: Promise.race([
            ready,
            done.then(() => Promise.reject(new Error("build stopped before ready"))),
          ]),
          controller,
        };
      };

      // Build A goes live on its own: the live schema has no build yet.
      const a = start(projectA(proxy.url, token), { account: accountA }, "if-none");
      const buildA = await a.ready;
      expect((await liveState(sql, "live"))?.activeBuild).toBe(buildA);

      const api = await createLiveApi({ sql, live: "live", pollIntervalMs: 100 });
      expect(api.buildId()).toBe(buildA);

      // Clients query continuously, through everything that follows.
      const errors: string[] = [];
      let queries = 0;
      const loopState = { stop: false };
      const loop = (async () => {
        while (!loopState.stop) {
          const g = await api.app.request("/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              query:
                "{ _meta { chains { blockNumber } } accounts(orderBy: [{ id: ASC }]) { totalCount nodes { id balance } } }",
            }),
          });
          const gBody = (await g.json()) as {
            errors?: { message: string }[];
            data?: { accounts: { totalCount: number } };
          };
          if (g.status !== 200 || gBody.errors !== undefined)
            errors.push(`graphql ${g.status}: ${JSON.stringify(gBody.errors)}`);
          const s = await api.app.request("/sql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "select id, balance from account order by id" }),
          });
          if (s.status !== 200) errors.push(`sql ${s.status}: ${await s.text()}`);
          queries++;
          await new Promise((r) => setTimeout(r, 5));
        }
      })();

      // More activity while A serves, so the new build has realtime blocks to cover too.
      await send("transfer", recipients[0] as Address, 7n);
      await anvil.testClient.mine({ blocks: 3 });

      // A redeploy follows a build that has been running: wait until A has seen the chain's
      // finalised block, so everything final is in the sync cache.
      const finalized = Number((await anvil.publicClient.getBlock({ blockTag: "finalized" })).number);
      await waitForAsync(async () => {
        const [row] = await sql.unsafe<{ f: string }[]>(
          `select finalized_block::text as f from ${buildSchemaName(buildA)}."_tm_checkpoints"`,
        );
        return Number(row?.f ?? -1) >= finalized;
      });

      // Build B indexes its history from the sync cache: no ranged eth_getLogs at all.
      counting = true;
      const b = start(projectB(proxy.url, token), { account: accountB }, "never");
      const buildB = await b.ready;
      counting = false;
      expect(buildB).not.toBe(buildA);
      expect(rangedGetLogs).toBe(0);
      expect(api.buildId()).toBe(buildA); // not promoted yet
      expect((await getBuild(sql, buildB))?.status).toBe("ready");

      // Cut over: the API serves B, with its new column, without a restart.
      await cutover(sql, "live", buildB);
      await waitFor(() => api.buildId() === buildB);
      const gql = async (query: string) => {
        const res = await api.app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        });
        return (await res.json()) as {
          data?: { accounts: { nodes: { id: string; transfers?: number }[] } };
          errors?: unknown[];
        };
      };
      await send("transfer", recipients[1] as Address, 9n);
      const withCounts = await gql("{ accounts(orderBy: [{ id: ASC }]) { nodes { id transfers } } }");
      expect(withCounts.errors).toBeUndefined();
      expect(withCounts.data?.accounts.nodes.length).toBe(recipients.length + 1);
      const viaView = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from "live"."account"`);
      expect(Number(viaView[0]?.n)).toBe(recipients.length + 1);

      // Roll back: A again, which kept indexing while B served.
      expect(await rollback(sql, "live")).toBe(buildA);
      await waitFor(() => api.buildId() === buildA);
      const old = await gql("{ accounts { nodes { id transfers } } }");
      expect(old.errors).toBeDefined(); // A has no such column
      const balances = await gql("{ accounts(orderBy: [{ id: ASC }]) { nodes { id } } }");
      expect(balances.errors).toBeUndefined();

      await new Promise((r) => setTimeout(r, 200));
      loopState.stop = true;
      await loop;
      expect(errors).toEqual([]);
      expect(queries).toBeGreaterThan(10);

      // Neither build can be pruned: one is active, the other is the rollback target.
      expect(await pruneBuilds(sql, new Date(Date.now() + 60_000))).toEqual([]);
      expect((await listBuilds(sql)).map((r) => r.buildId).sort()).toEqual([buildA, buildB].sort());
      await api.close();
    } finally {
      for (const c of aborts) c.abort();
      await Promise.allSettled(runs);
      await proxy.stop();
      await sql.end();
      await db.drop();
      await anvil.stop();
    }
  }, 120_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
