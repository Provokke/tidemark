import {
  childAbi,
  factoryAbi,
  factoryBytecode,
  routerAbi,
  routerBytecode,
  tokenAbi,
  tokenBytecode,
} from "@tidemark/contracts";
import { type Sql, connect } from "@tidemark/pg";
import { RpcPool } from "@tidemark/rpc";
import { onchainTable, primaryKey, t } from "@tidemark/schema";
import {
  type Anvil,
  type TestDatabase,
  createTestDatabase,
  startAnvil,
  startRpcProxy,
} from "@tidemark/testing";
import { type Address, type Hex, encodeFunctionData, getAddress, parseAbiItem, parseEventLogs } from "viem";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createTidemark, defineConfig, factory, runHistorical, runIndexer } from "../src/index.js";

const ping = onchainTable("ping", {
  id: t.text().primaryKey(),
  child: t.hex().notNull(),
  pingId: t.bigint().notNull(),
  block: t.bigint().notNull(),
});
const child = onchainTable("child", {
  id: t.hex().primaryKey(),
  label: t.text().notNull(),
  block: t.bigint().notNull(),
});
const tick = onchainTable("tick", { block: t.bigint().primaryKey(), timestamp: t.timestamp().notNull() });
const call = onchainTable("call", {
  id: t.text().primaryKey(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  value: t.bigint().notNull(),
  ok: t.boolean().notNull(),
  depth: t.integer().notNull(),
});
const transfer = onchainTable(
  "transfer",
  {
    tx: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    sender: t.hex().notNull(),
    gasUsed: t.bigint().notNull(),
    balanceAfter: t.bigint().notNull(),
  },
  (x) => ({ pk: primaryKey({ columns: [x.tx, x.logIndex] }) }),
);
const schema = { ping, child, tick, call, transfer };

let anvil: Anvil;
let db: TestDatabase;
let sql: Sql;
let factoryAddress: Address;
let token: Address;
let router: Address;
const CHILDREN = 2_000;
/**
 * Called after each transaction. The realtime test waits there for the indexer to reach the head:
 * Anvil answers an `eth_call` at the head block's hash from its live state, which can already hold
 * the next auto-mined transaction, so a read racing the next send would see the future. Real nodes
 * serve the block's own state; this only keeps the test's reads deterministic.
 */
let afterSend: () => Promise<void> = () => Promise.resolve();
const send = async (hash: Promise<Hex>) => {
  const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash: await hash });
  await afterSend();
  return receipt;
};

async function activity(round: number) {
  // New children, pings from old and new ones, token calls direct and through the router.
  await send(
    anvil.walletClient.writeContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "createChildren",
      args: [BigInt(10_000 + round * 10), 3n, "late"],
      gas: 5_000_000n,
    }),
  );
  for (const salt of [round * 31, 10_000 + round * 10]) {
    const c = await anvil.publicClient.readContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "predict",
      args: [`0x${BigInt(salt).toString(16).padStart(64, "0")}`, salt >= 10_000 ? "late" : "c"],
    });
    await send(
      anvil.walletClient.writeContract({
        address: c,
        abi: childAbi,
        functionName: "ping",
        args: [BigInt(round)],
      }),
    );
  }
  const to = getAddress(`0x${(round + 1).toString(16).padStart(40, "0")}`);
  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "transfer",
      args: [to, BigInt(round + 1)],
    }),
  );
  await send(
    anvil.walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "nested",
      args: [
        token,
        [
          encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to, 1n] }),
          encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [to, 10n ** 30n] }),
        ],
      ],
    }),
  );
}

beforeAll(async () => {
  anvil = await startAnvil();
  db = await createTestDatabase();
  sql = connect(db.url, { max: 6 });
  const deploy = async (abi: unknown, bytecode: Hex) =>
    (await send(anvil.walletClient.deployContract({ abi, bytecode } as never))).contractAddress as Address;
  factoryAddress = await deploy(factoryAbi, factoryBytecode);
  token = await deploy(tokenAbi, tokenBytecode);
  router = await deploy(routerAbi, routerBytecode);
  const me = anvil.walletClient.account.address;
  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "mint",
      args: [me, 10n ** 24n],
    }),
  );
  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "mint",
      args: [router, 10n ** 6n],
    }),
  );
  for (let i = 0; i < CHILDREN / 100; i++) {
    await send(
      anvil.walletClient.writeContract({
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "createChildren",
        args: [BigInt(i * 100), 100n, "c"],
        gas: 29_000_000n,
      }),
    );
  }
  for (let round = 0; round < 10; round++) await activity(round);
  await anvil.testClient.mine({ blocks: 64 });
}, 600_000);

afterAll(async () => {
  await sql.end();
  await db.drop();
  await anvil.stop();
});

function project(finality: "tag" | { depth: number }) {
  const config = defineConfig({
    chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality, maxLogRange: 500 } },
    contracts: {
      Child: {
        chain: "anvil",
        abi: childAbi,
        address: factory({
          address: factoryAddress,
          event: parseAbiItem(
            "event ChildCreated(address indexed child, bytes32 indexed salt, string label)",
          ),
          parameter: "child",
        }),
        startBlock: 0,
      },
      Token: {
        chain: "anvil",
        abi: tokenAbi,
        address: token,
        startBlock: 0,
        includeCallTraces: true,
        includeTransaction: true,
        includeReceipt: true,
      },
    },
    blocks: { Every5: { chain: "anvil", interval: 5, startBlock: 2 } },
  });
  const tidemark = createTidemark(config);
  tidemark.on("Child:Initialized", async ({ event, context }) => {
    await context.db
      .insert(child)
      .values({ id: event.log.address, label: event.args.label, block: event.block.number });
  });
  tidemark.on("Child:Ping", async ({ event, context }) => {
    await context.db.insert(ping).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      child: event.log.address,
      pingId: event.args.id,
      block: event.block.number,
    });
  });
  tidemark.on("Every5:block", async ({ event, context }) => {
    await context.db.insert(tick).values({ block: event.block.number, timestamp: event.block.timestamp });
  });
  tidemark.on("Token.transfer()", async ({ event, context }) => {
    expectTypeOf(event.args).toEqualTypeOf<readonly [`0x${string}`, bigint]>();
    expectTypeOf(event.result).toEqualTypeOf<boolean>();
    const [to, value] = event.args;
    await context.db.insert(call).values({
      id: `${event.transaction.hash}-${event.trace.traceAddress.join(".")}`,
      from: event.trace.from,
      to,
      value,
      ok: event.result,
      depth: event.trace.traceAddress.length,
    });
  });
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    if (event.args.from === "0x0000000000000000000000000000000000000000") return;
    const balance = (await context.client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [event.args.to],
    })) as bigint;
    await context.db.insert(transfer).values({
      tx: event.transaction.hash,
      logIndex: event.log.logIndex,
      sender: event.transaction.from ?? "0x",
      gasUsed: event.receipt?.gasUsed ?? -1n,
      balanceAfter: balance,
    });
  });
  return tidemark;
}

async function dump(s: Sql, schemaName: string) {
  const q = (text: string) => s.unsafe(text.replaceAll("S.", `"${schemaName}".`));
  return {
    children: (await q("select count(*)::int as n from S.child"))[0]?.n as number,
    pings: (
      await q("select id, encode(child, 'hex') as child, ping_id::text, block::text from S.ping order by id")
    ).map((r) => Object.fromEntries(Object.entries(r))),
    ticks: (await q("select block::text as b from S.tick order by block")).map((r) => r.b as string),
    calls: (
      await q(
        "select id, encode(\"from\", 'hex') as f, encode(\"to\", 'hex') as t, value::text, ok, depth from S.call order by id",
      )
    ).map((r) => Object.fromEntries(Object.entries(r))),
    transfers: (
      await q(
        "select encode(tx, 'hex') as tx, log_index, encode(sender, 'hex') as sender, gas_used::text, balance_after::text from S.transfer order by tx, log_index",
      )
    ).map((r) => Object.fromEntries(Object.entries(r))),
  };
}

describe("source kinds, historical", () => {
  it("indexes factory children, interval blocks, calls, transactions, receipts and reads, each against its reference", async () => {
    const proxy = await startRpcProxy({ target: anvil.rpcUrl });
    try {
      const createPool = (_: string, chainId: number) => new RpcPool({ chainId, endpoints: [proxy.url] });
      const result = await runHistorical({
        tidemark: project("tag"),
        schema,
        sql,
        indexSchema: "kinds",
        createPool,
      });
      const finalized = result.chains[0]?.finalizedBlock ?? 0;
      const d = await dump(sql, "kinds");

      // Factory: every child's Initialized, every child's Ping; never the factory's own events.
      const created = parseEventLogs({
        abi: factoryAbi,
        eventName: "ChildCreated",
        logs: await anvil.publicClient.getLogs({
          address: factoryAddress,
          fromBlock: 0n,
          toBlock: BigInt(finalized),
        }),
      });
      expect(d.children).toBe(created.length);
      expect(created.length).toBe(CHILDREN + 30);
      const childSet = new Set(created.map((c) => c.args.child.toLowerCase()));
      const pings = parseEventLogs({
        abi: childAbi,
        eventName: "Ping",
        logs: await anvil.publicClient.getLogs({ fromBlock: 0n, toBlock: BigInt(finalized) }),
      }).filter((l) => childSet.has(l.address.toLowerCase()));
      expect(d.pings.map((p) => p.id).sort()).toEqual(
        pings.map((p) => `${p.transactionHash}-${p.logIndex}`).sort(),
      );

      // Blocks: 2, 7, 12, ... up to the finalised block.
      const expectedTicks = [];
      for (let b = 2; b <= finalized; b += 5) expectedTicks.push(String(b));
      expect(d.ticks).toEqual(expectedTicks);

      // Calls: one per effective transfer(), the same as Transfer events from a non-zero sender.
      const transfers = parseEventLogs({
        abi: tokenAbi,
        eventName: "Transfer",
        logs: await anvil.publicClient.getLogs({ address: token, fromBlock: 0n, toBlock: BigInt(finalized) }),
      }).filter((e) => e.args.from !== "0x0000000000000000000000000000000000000000");
      expect(d.calls.length).toBe(transfers.length);
      expect(d.calls.every((c) => c.ok === true)).toBe(true);
      expect(d.calls.filter((c) => (c.depth as number) > 0).length).toBe(10); // the nested router calls that succeeded

      // Transactions, receipts and reads at the event's block.
      expect(d.transfers.length).toBe(transfers.length);
      for (const row of d.transfers.slice(0, 5)) {
        const hash = `0x${row.tx as string}` as Hex;
        const receipt = await anvil.publicClient.getTransactionReceipt({ hash });
        expect(row.gas_used).toBe(receipt.gasUsed.toString());
        expect(`0x${row.sender as string}`).toBe(receipt.from.toLowerCase());
        const log = transfers.find((e) => e.transactionHash === hash);
        const balance = await anvil.publicClient.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [log?.args.to as Address],
          blockNumber: receipt.blockNumber,
        });
        expect(row.balance_after).toBe(balance.toString());
      }

      // A second, independent index of the same range reads everything from the cache.
      proxy.resetCalls();
      await runHistorical({ tidemark: project("tag"), schema, sql, indexSchema: "kinds_again", createPool });
      expect(proxy.totalCalls("eth_call")).toBe(0);
      expect(proxy.totalCalls("eth_getLogs")).toBe(0);
      expect(proxy.totalCalls("trace_filter")).toBe(0);
      expect(proxy.totalCalls("eth_getTransactionReceipt")).toBe(0);
      expect(await dump(sql, "kinds_again")).toEqual(d);
    } finally {
      await proxy.stop();
    }
  }, 300_000);
});

describe("source kinds, realtime", () => {
  it("follows the head through new children, calls, ticks and reorgs, and equals a from-scratch index", async () => {
    const controller = new AbortController();
    let hash = "";
    const done = runIndexer({
      tidemark: project("tag"),
      schema,
      sql,
      indexSchema: "kinds_live",
      signal: controller.signal,
      realtime: {
        pollIntervalMs: 20,
        onEvent: (e) => {
          if (e.type === "block") hash = e.block.header.hash;
          else if (e.type === "reorg") hash = e.ancestor.hash;
        },
      },
    });
    done.catch(() => undefined);
    const caughtUp = async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (hash === (await anvil.publicClient.getBlock()).hash) return;
        if (Date.now() > deadline) throw new Error("indexer did not catch up");
        await Promise.race([done, new Promise((r) => setTimeout(r, 20))]);
      }
    };
    afterSend = caughtUp;
    try {
      await caughtUp();
      for (let round = 10; round < 16; round++) {
        await activity(round);
        if (round % 2 === 0) {
          await caughtUp();
          await anvil.reorg(3); // drops the router call and a ping; the next round replaces them
        }
      }
      await anvil.testClient.mine({ blocks: 2 });
      await caughtUp();
    } finally {
      afterSend = () => Promise.resolve();
      controller.abort();
      await done;
    }
    const refDb = await createTestDatabase();
    const refSql = connect(refDb.url);
    try {
      await runHistorical({ tidemark: project({ depth: 0 }), schema, sql: refSql, indexSchema: "ref" });
      expect(await dump(sql, "kinds_live")).toEqual(await dump(refSql, "ref"));
    } finally {
      await refSql.end();
      await refDb.drop();
    }
  }, 300_000);
});
