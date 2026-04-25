/** Time travel through the API: every form of `at`, finalised-consistent reads, and the refusals. */
import { createApi } from "@tidemark/api";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { createTestDatabase, startAnvil } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import { createTidemark, defineConfig, runIndexer } from "../src/index.js";

const account = onchainTable(
  "account",
  { id: t.hex().primaryKey(), balance: t.bigint().notNull() },
  undefined,
  { history: true },
);
const ledger = onchainTable("ledger", { id: t.text().primaryKey(), to: t.hex().notNull() });
const ZERO = "0x0000000000000000000000000000000000000000";
const alice = getAddress("0x00000000000000000000000000000000000a11ce");

it("reads at a block, a timestamp, a checkpoint and the finalised state, and refuses what it cannot answer", async () => {
  const anvil = await startAnvil();
  const db = await createTestDatabase();
  const sql = connect(db.url, { max: 8 });
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
  await send("mint", anvil.walletClient.account.address, 1000n);
  const blocks: { number: bigint; timestamp: bigint }[] = [];
  for (const amount of [1n, 2n, 3n, 4n]) {
    const receipt = await send("transfer", alice, amount);
    const block = await anvil.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    blocks.push({ number: block.number, timestamp: block.timestamp });
    await anvil.testClient.increaseTime({ seconds: 10 });
  }

  const tidemark = createTidemark(
    defineConfig({
      chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality: { depth: 2 } } },
      contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
    }),
  );
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    const { from, to, value } = event.args;
    await context.db.insert(ledger).values({ id: `${event.transaction.hash}-${event.log.logIndex}`, to });
    if (from !== ZERO)
      await context.db.update(account, { id: from }).set((r) => ({ balance: r.balance - value }));
    await context.db
      .insert(account)
      .values({ id: to, balance: value })
      .onConflictDoUpdate((r) => ({ balance: r.balance + value }));
  });
  // Realtime, so the head is indexed but two blocks are not final yet.
  const controller = new AbortController();
  let ready: () => void = () => undefined;
  const isReady = new Promise<void>((r) => (ready = r));
  const run = runIndexer({
    tidemark,
    schema: { account, ledger },
    sql,
    indexSchema: "app",
    signal: controller.signal,
    realtime: { pollIntervalMs: 30 },
    onReady: () => ready(),
  });
  run.catch(() => undefined);
  const api = createApi({ sql, schema: { account, ledger }, databaseSchema: "app" });
  const gql = async (query: string, variables?: Record<string, unknown>) => {
    const res = await api.app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as {
      data?: Record<string, { balance: string } | null>;
      errors?: { message: string }[];
    };
  };
  const aliceAt = async (at: string) =>
    (await gql(`{ account(id: "${alice}", at: ${at}) { balance } }`)).data?.account?.balance ?? null;
  try {
    await isReady;
    const [b1, b2, b3, b4] = blocks as [
      (typeof blocks)[number],
      (typeof blocks)[number],
      (typeof blocks)[number],
      (typeof blocks)[number],
    ];
    expect(await aliceAt(`{ block: "${b1.number - 1n}" }`)).toBeNull(); // before her first transfer
    expect(await aliceAt(`{ block: "${b1.number}" }`)).toBe("1");
    expect(await aliceAt(`{ block: "${b3.number}" }`)).toBe("6");
    expect(await aliceAt(`{ block: "${b4.number + 100n}" }`)).toBe("10"); // past the head: the latest state
    expect(await aliceAt(`{ timestamp: ${b2.timestamp} }`)).toBe("3");
    expect(await aliceAt(`{ timestamp: ${b2.timestamp + 5n} }`)).toBe("3"); // between blocks
    // Finalised: head - 2, so the last two transfers are not visible yet.
    expect(await aliceAt("{ finalized: true }")).toBe("3");
    expect((await gql(`{ account(id: "${alice}") { balance } }`)).data?.account?.balance).toBe("10");

    // A checkpoint, from the history itself.
    const [version] = await sql.unsafe<{ from: string }[]>(
      `select tm_valid_from as "from" from app."_tm_history_account" where balance = 6`,
    );
    expect(await aliceAt(`{ checkpoint: "${version?.from}" }`)).toBe("6");

    // One point in time per request; history is needed for every table read in the past; bad input.
    const two = await gql(
      `{ a: account(id: "${alice}", at: { block: "${b1.number}" }) { balance } b: account(id: "${alice}", at: { block: "${b2.number}" }) { balance } }`,
    );
    expect(two.errors?.[0]?.message).toMatch(/same `at`/);
    const both = await gql(`{ account(id: "${alice}", at: { block: "1", timestamp: 5 }) { balance } }`);
    expect(both.errors?.[0]?.message).toMatch(/exactly one/);
    const noHistory = await gql(
      `{ account(id: "${alice}", at: { block: "${b2.number}" }) { balance } ledgers { totalCount } }`,
    );
    expect(noHistory.errors?.[0]?.message).toMatch(/ledger keeps no history/);
    expect(
      (await gql(`{ account(id: "${alice}", at: { checkpoint: "1; drop table x" }) { balance } }`))
        .errors?.[0]?.message,
    ).toMatch(/75 digits/);
    expect((await gql(`{ ledgers(at: { finalized: true }) { totalCount } }`)).errors?.[0]?.message).toMatch(
      /Unknown argument "at"/,
    );

    // SQL: the functions are allowed, and nothing else from the build schema is.
    const sqlQuery = async (query: string, params: unknown[] = []) =>
      (await (
        await api.app.request("/sql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, params }),
        })
      ).json()) as { rows?: unknown[][]; error?: string };
    expect(
      (await sqlQuery("select balance::text from account_at(tm_finalized_checkpoint()) order by balance"))
        .rows,
    ).toEqual([["3"], ["997"]]);
    expect(
      (
        await sqlQuery("select balance::text from account_at(tm_timestamp_checkpoint($1)) order by balance", [
          Number(b1.timestamp),
        ])
      ).rows,
    ).toEqual([["1"], ["999"]]);
    expect((await sqlQuery("select * from _tm_history_account")).error).toMatch(/not readable/);
    expect((await sqlQuery("select * from ledger_at('1')")).error).toMatch(/not allowed/);
  } finally {
    controller.abort();
    await run.catch(() => undefined);
    await api.close();
    await sql.end();
    await db.drop();
    await anvil.stop();
  }
}, 120_000);
