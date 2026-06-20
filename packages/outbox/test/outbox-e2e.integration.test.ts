/**
 * The outbox end to end: on a live chain, `latest` messages arrive at once and are
 * retracted when a reorg removes them; `finalized` messages arrive only once final (so a reorged one
 * never arrives); failures retry with backoff, permanent failures go dead and redrive; a redeploy
 * sends nothing twice. Every request is checked against its signature.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import {
  type BuildResult,
  type OutboxMessage,
  createTidemark,
  defineConfig,
  liveState,
  runBuild,
} from "@tidemark/engine";
import { connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { createTestDatabase, startAnvil } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import { listDeliveries, redrive, runOutboxDispatcher, verifySignature } from "../src/index.js";

const SECRETS = ["outbox-test-secret-0001", "outbox-test-secret-0002"];
const transfer = onchainTable("transfer", { id: t.text().primaryKey(), to: t.hex().notNull() });
const alice = getAddress("0x00000000000000000000000000000000000a11ce");
const bob = getAddress("0x0000000000000000000000000000000000000b0b");
const carol = getAddress("0x00000000000000000000000000000000000ca201");
const dave = getAddress("0x0000000000000000000000000000000000000dae");

interface Received {
  readonly message: OutboxMessage;
  readonly attempt: number;
  readonly accepted: boolean;
}

it("delivers, retracts, retries, redrives, and survives a redeploy without re-sending", async () => {
  const anvil = await startAnvil();
  const db = await createTestDatabase();
  const sql = connect(db.url, { max: 12 });

  // The receiver: checks every signature; `answer` decides the status per message.
  const received: Received[] = [];
  let answer: (m: OutboxMessage) => number = () => 200;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (!verifySignature(body, req.headers["tidemark-signature"] as string, SECRETS)) {
        res.writeHead(401).end();
        throw new Error("bad signature");
      }
      const message = JSON.parse(body) as OutboxMessage;
      const status = answer(message);
      received.push({ message, attempt: Number(req.headers["tidemark-attempt"]), accepted: status < 300 });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

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
  await anvil.testClient.mine({ blocks: 5 });

  const outbox = {
    destinations: { hook: { kind: "webhook" as const, url: hookUrl, secrets: SECRETS, insecure: true } },
    routes: { "transfer.seen": ["hook"], "transfer.final": ["hook"] },
    maxAttempts: 4,
  };
  const project = (variant: string) => {
    const tidemark = createTidemark(
      defineConfig({
        chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality: { depth: 3 } } },
        contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
        outbox,
      }),
    );
    tidemark.on("Token:Transfer", async ({ event, context }) => {
      await context.db
        .insert(transfer)
        .values({ id: `${event.transaction.hash}-${event.log.logIndex}-${variant}`, to: event.args.to });
      await context.outbox.emit(
        "transfer.seen",
        { to: event.args.to, value: event.args.value },
        { when: "latest" },
      );
      await context.outbox.emit("transfer.final", { to: event.args.to, value: event.args.value });
    });
    return tidemark;
  };

  const controllers: AbortController[] = [];
  const runs: Promise<unknown>[] = [];
  const start = (variant: string, promote: "if-none" | "when-ready") => {
    const controller = new AbortController();
    controllers.push(controller);
    let resolveId: (id: string) => void = () => undefined;
    const id = new Promise<string>((r) => (resolveId = r));
    const run: Promise<BuildResult> = runBuild({
      tidemark: project(variant),
      schema: { transfer },
      sql,
      // The variants differ only in a closed-over string, which the handlers' source does not show.
      code: `outbox-e2e-${variant}`,
      signal: controller.signal,
      promote,
      realtime: { pollIntervalMs: 30 },
      onBuild: (e) => {
        if (e.status === "active") resolveId(e.buildId);
      },
    });
    run.catch(() => undefined);
    runs.push(run);
    return Promise.race([
      id,
      run.then(() => Promise.reject(new Error(`build ${variant} stopped before going live`))),
    ]);
  };
  const dispatcherStop = new AbortController();
  const dispatching = runOutboxDispatcher({
    sql,
    config: outbox,
    signal: dispatcherStop.signal,
    pollIntervalMs: 100,
    baseBackoffMs: 50,
    maxBackoffMs: 200,
  });
  dispatching.catch(() => undefined);

  const accepted = (type: string, to: Address) =>
    received.filter(
      (r) =>
        r.accepted && r.message.type === type && (r.message.data as { to: string }).to === to.toLowerCase(),
    );
  const waitFor = async (what: string, condition: () => boolean, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  try {
    const buildA = await start("a", "if-none");

    // Mint and the first transfer are history: final ones arrive once, `latest` ones too.
    await send("transfer", alice, 1n);
    const sentAt = Date.now();
    await waitFor("alice seen", () => accepted("transfer.seen", alice).length === 1);
    const latency = Date.now() - sentAt;
    expect(accepted("transfer.final", alice)).toHaveLength(0); // not final yet
    await anvil.testClient.mine({ blocks: 3 });
    await waitFor("alice final", () => accepted("transfer.final", alice).length === 1);
    const final = accepted("transfer.final", alice)[0]?.message;
    expect(final?.block.finalized).toBe(true);
    expect(final).toMatchObject({
      specVersion: "1",
      build: buildA,
      chainId: 31_337,
      data: { to: alice.toLowerCase(), value: "1" },
    });

    // A reorg removes bob's transfer after its `latest` message went out: a retraction follows,
    // with the same id; its `finalized` message never goes out.
    await send("transfer", bob, 2n);
    await waitFor("bob seen", () => accepted("transfer.seen", bob).length === 1);
    const bobSeen = accepted("transfer.seen", bob)[0]?.message;
    await anvil.reorg(1);
    await anvil.testClient.mine({ blocks: 1 });
    await waitFor("bob retraction", () => accepted("transfer.seen.retracted", bob).length === 1);
    expect(accepted("transfer.seen.retracted", bob)[0]?.message.id).toBe(bobSeen?.id);
    await anvil.testClient.mine({ blocks: 4 });

    // Temporary failures retry with backoff until accepted.
    let failures = 2;
    answer = (m) => ((m.data as { to: string }).to === carol.toLowerCase() && failures-- > 0 ? 503 : 200);
    await send("transfer", carol, 3n);
    await waitFor("carol seen after retries", () => accepted("transfer.seen", carol).length === 1);
    expect(accepted("transfer.seen", carol)[0]?.attempt).toBe(3);

    // A permanent failure goes dead at once; redrive sends it again.
    answer = (m) => ((m.data as { to: string }).to === dave.toLowerCase() ? 400 : 200);
    await send("transfer", dave, 4n);
    await waitFor("dave dead", () =>
      received.some((r) => !r.accepted && (r.message.data as { to: string }).to === dave.toLowerCase()),
    );
    await new Promise((r) => setTimeout(r, 300));
    const dead = await listDeliveries(sql, { status: "dead" });
    expect(dead.map((d) => [d.topic, d.attempts])).toEqual([["transfer.seen", 1]]);
    answer = () => 200;
    expect(await redrive(sql, { ids: dead.map((d) => d.id) })).toBe(1);
    await waitFor("dave redriven", () => accepted("transfer.seen", dave).length === 1);
    await anvil.testClient.mine({ blocks: 4 });
    await waitFor(
      "all final",
      () => accepted("transfer.final", carol).length === 1 && accepted("transfer.final", dave).length === 1,
    );

    // A redeploy: build B re-indexes the same history (same deterministic ids) and goes live.
    const before = received.filter((r) => r.accepted).length;
    const buildB = await start("b", "when-ready");
    expect(buildB).not.toBe(buildA);
    expect((await liveState(sql, "live"))?.activeBuild).toBe(buildB);
    await anvil.testClient.mine({ blocks: 2 });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(received.filter((r) => r.accepted).length).toBe(before);
    // New activity is delivered by B, once.
    await send("transfer", alice, 5n);
    await waitFor("alice again", () => accepted("transfer.seen", alice).length === 2);
    expect(accepted("transfer.seen", alice)[1]?.message.build).toBe(buildB);

    // Every accepted (id, type) pair arrived exactly once; bob's final message never did.
    const keys = received.filter((r) => r.accepted).map((r) => `${r.message.id}:${r.message.type}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(accepted("transfer.final", bob)).toHaveLength(0);
    console.log(`latest delivery latency: ${latency} ms`);
  } finally {
    dispatcherStop.abort();
    for (const c of controllers) c.abort();
    await Promise.allSettled([dispatching, ...runs]);
    server.close();
    await sql.end();
    await db.drop();
    await anvil.stop();
  }
}, 120_000);
