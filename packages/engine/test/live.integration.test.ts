/**
 * A live query sees each indexed change within a second of
 * the block, follows a reorg back, and follows a cutover to a new build, over one WebSocket.
 */
import { GRAPHQL_WS_PROTOCOL, createLiveApi, serveApp } from "@tidemark/api";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { createTestDatabase, startAnvil } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import { createTidemark, cutover, defineConfig, runBuild } from "../src/index.js";

const account = onchainTable("account", { id: t.hex().primaryKey(), balance: t.bigint().notNull() });
const ZERO = "0x0000000000000000000000000000000000000000";
const alice = getAddress("0x00000000000000000000000000000000000a11ce");

it("pushes changes within a second, through a reorg and a cutover", async () => {
  const anvil = await startAnvil();
  const db = await createTestDatabase();
  const sql = connect(db.url, { max: 12 });
  const hash = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
  const token = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  const send = async (functionName: "mint" | "transfer", to: Address, amount: bigint) =>
    anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName,
        args: [to, amount],
      }),
    });
  await send("mint", anvil.walletClient.account.address, 10n ** 21n);

  const project = (factor: bigint) => {
    const tidemark = createTidemark(
      defineConfig({
        chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality: { depth: 5 } } },
        contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
      }),
    );
    tidemark.on("Token:Transfer", async ({ event, context }) => {
      const value = event.args.value * factor;
      if (event.args.from !== ZERO) {
        await context.db
          .update(account, { id: event.args.from })
          .set((r) => ({ balance: r.balance - value }));
      }
      await context.db
        .insert(account)
        .values({ id: event.args.to, balance: value })
        .onConflictDoUpdate((r) => ({ balance: r.balance + value }));
    });
    return tidemark;
  };
  const controllers: AbortController[] = [];
  const runs: Promise<unknown>[] = [];
  const start = (factor: bigint, promote: "if-none" | "never") => {
    const controller = new AbortController();
    controllers.push(controller);
    let resolveReady: (id: string) => void = () => undefined;
    const ready = new Promise<string>((r) => (resolveReady = r));
    const run = runBuild({
      tidemark: project(factor),
      schema: { account },
      sql,
      code: `live-${factor}`,
      signal: controller.signal,
      promote,
      realtime: { pollIntervalMs: 50 },
      onBuild: (e) => {
        if (e.status === (promote === "never" ? "ready" : "active")) resolveReady(e.buildId);
      },
    });
    run.catch(() => undefined);
    runs.push(run);
    return Promise.race([ready, run.then(() => Promise.reject(new Error("build stopped")))]);
  };

  const api = await createLiveApi({ sql, live: "live", pollIntervalMs: 200 });
  const server = await serveApp(api.app, 0, "127.0.0.1", { live: api.live });
  const ws = new WebSocket(`${server.url.replace("http", "ws")}/graphql/ws`, GRAPHQL_WS_PROTOCOL);
  const opened = new Promise<void>((resolve) => (ws.onopen = () => resolve()));
  const updates: { at: number; balance: string | null }[] = [];
  try {
    await start(1n, "if-none");
    await api.reload();
    await opened;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as {
        type: string;
        payload?: { data?: { account: { balance: string } | null } };
      };
      if (m.type === "next")
        updates.push({ at: Date.now(), balance: m.payload?.data?.account?.balance ?? null });
    };
    ws.send(JSON.stringify({ type: "connection_init" }));
    ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "alice",
        payload: { query: "query($id: Hex!) { account(id: $id) { balance } }", variables: { id: alice } },
      }),
    );
    const next = async (count: number) => {
      const deadline = Date.now() + 10_000;
      while (updates.length < count) {
        if (Date.now() > deadline)
          throw new Error(`waited for update ${count}; have ${JSON.stringify(updates)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return updates[count - 1] as (typeof updates)[number];
    };
    expect((await next(1)).balance).toBeNull();

    // Each transfer, from the block being mined to the push.
    const latencies: number[] = [];
    for (const [i, amount] of [5n, 7n, 11n].entries()) {
      const mined = Date.now();
      await send("transfer", alice, amount);
      const update = await next(i + 2);
      latencies.push(update.at - mined);
    }
    expect(updates.map((u) => u.balance)).toEqual([null, "5", "12", "23"]);
    expect(Math.max(...latencies)).toBeLessThan(1_000);

    // A reorg drops the last transfer: the live query goes back.
    await anvil.reorg(1);
    await anvil.testClient.mine({ blocks: 1 });
    expect((await next(5)).balance).toBe("12");

    // A cutover to a build that counts double: the same subscription follows it.
    const b = await start(2n, "never");
    await cutover(sql, "live", b);
    expect((await next(6)).balance).toBe("24");
    console.log(`live query latency from block: ${latencies.join(", ")} ms`);

    // What happened is visible in /metrics.
    const scraped = await (await fetch(`${server.url}/metrics`)).text();
    const value = (pattern: RegExp) => Number(pattern.exec(scraped)?.[1] ?? Number.NaN);
    expect(value(/^tm_events_total\{chain="anvil",event="Token:Transfer"\} (\d+)$/m)).toBeGreaterThanOrEqual(
      4,
    );
    expect(value(/^tm_reorgs_total\{chain="anvil"\} (\d+)$/m)).toBeGreaterThanOrEqual(1);
    expect(value(/^tm_realtime_lag_blocks\{chain="anvil"\} (\d+)$/m)).toBeLessThanOrEqual(1);
    expect(value(/^tm_live_queries (\d+)$/m)).toBe(1);
    expect(
      value(
        /^tm_rpc_requests_total\{chain="31337",method="eth_getBlockByNumber",endpoint="[^"]+",outcome="ok"\} (\d+)$/m,
      ),
    ).toBeGreaterThan(0);
    expect(scraped).toMatch(/^tm_flush_seconds_count\{schema="tm_build_[0-9a-f]{16}"\} \d+$/m);
    expect(scraped).toMatch(/^tm_handler_seconds_bucket\{event="Token:Transfer",le="\+Inf"\} \d+$/m);
  } finally {
    ws.close();
    for (const c of controllers) c.abort();
    await Promise.allSettled(runs);
    await server.close();
    await api.close();
    await sql.end();
    await db.drop();
    await anvil.stop();
  }
}, 120_000);
