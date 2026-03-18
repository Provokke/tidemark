import type { Hex } from "@tidemark/core";
import {
  childBytecode,
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
import {
  type Anvil,
  type TestDatabase,
  createTestDatabase,
  startAnvil,
  startRpcProxy,
} from "@tidemark/testing";
import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseEventLogs,
  toEventSelector,
  toFunctionSelector,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FactoryLogSourceSpec,
  HistoricalSync,
  SyncStore,
  type TraceSourceSpec,
  factoryHash,
} from "../src/index.js";

const CHAIN = 31_337;
const CHILDREN = 5_000;
let anvil: Anvil;
let db: TestDatabase;
let sql: Sql;
let factory: Address;
let token: Address;
let router: Address;
let finalized: number;
const lower = (a: string) => a.toLowerCase() as Hex;

const PING = toEventSelector("Ping(uint256,address)");
const INITIALIZED = toEventSelector("Initialized(address,string)");
const CHILD_CREATED = toEventSelector("ChildCreated(address,bytes32,string)");

beforeAll(async () => {
  anvil = await startAnvil();
  db = await createTestDatabase();
  sql = connect(db.url, { max: 6 });
  const send = async (hash: Promise<Hex>) =>
    anvil.publicClient.waitForTransactionReceipt({ hash: await hash });
  const deploy = async (abi: never, bytecode: Hex, args?: unknown[]) =>
    (
      await send(
        anvil.walletClient.deployContract({
          abi,
          bytecode,
          ...(args === undefined ? {} : { args }),
        } as never),
      )
    ).contractAddress as Address;

  factory = await deploy(factoryAbi as never, factoryBytecode);
  token = await deploy(tokenAbi as never, tokenBytecode);
  router = await deploy(routerAbi as never, routerBytecode);
  for (let i = 0; i < CHILDREN / 100; i++) {
    await send(
      anvil.walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: "createChildren",
        args: [BigInt(i * 100), 100n, "c"],
        gas: 29_000_000n,
      }),
    );
    if (i % 10 === 0) await anvil.testClient.mine({ blocks: 2 });
  }
  // Pings from some children, and from a look-alike Child the factory did not create.
  for (let i = 0; i < 40; i++) {
    const salt = BigInt((i * 997) % CHILDREN);
    const child = await anvil.publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "predict",
      args: [`0x${salt.toString(16).padStart(64, "0")}`, "c"],
    });
    await send(
      anvil.walletClient.writeContract({
        address: child,
        abi: childAbi,
        functionName: "ping",
        args: [BigInt(i)],
      }),
    );
  }
  const stranger = await deploy(childAbi as never, childBytecode, ["c"]);
  await send(
    anvil.walletClient.writeContract({
      address: stranger,
      abi: childAbi,
      functionName: "ping",
      args: [999n],
    }),
  );

  // Token calls: direct, through the router, nested, failing, and under a reverted frame.
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
      args: [router, 1_000n],
    }),
  );
  const transfer = (to: number, amount: bigint) =>
    encodeFunctionData({
      abi: tokenAbi,
      functionName: "transfer",
      args: [getAddress(`0x${to.toString(16).padStart(40, "0")}`), amount],
    });
  await send(
    anvil.walletClient.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "transfer",
      args: [getAddress(`0x${"11".repeat(20)}`), 5n],
    }),
  );
  await send(
    anvil.walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "forward",
      args: [token, [transfer(1, 100n), transfer(2, 5_000n), transfer(3, 50n)]],
    }),
  );
  await send(
    anvil.walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "nested",
      args: [token, [transfer(4, 10n)]],
    }),
  );
  const thenRevert = encodeFunctionData({
    abi: routerAbi,
    functionName: "forwardThenRevert",
    args: [token, transfer(5, 1n)],
  });
  await send(
    anvil.walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: "forward",
      args: [router, [thenRevert]],
    }),
  );
  // A whole transaction that reverts: its calls never happened.
  await send(anvil.walletClient.sendTransaction({ to: router, data: thenRevert, gas: 200_000n }));

  await anvil.testClient.mine({ blocks: 64 });
  finalized = Number((await anvil.publicClient.getBlock({ blockTag: "finalized" })).number);
}, 600_000);

afterAll(async () => {
  await sql.end();
  await db.drop();
  await anvil.stop();
});

async function freshStore() {
  const store = new SyncStore(sql);
  await store.migrate();
  return store;
}

describe("factory sources", () => {
  const source = (): FactoryLogSourceSpec => ({
    kind: "factoryLog",
    factory: { chainId: CHAIN, address: [lower(factory)], selector: CHILD_CREATED, location: { topic: 1 } },
    topics: [[PING, INITIALIZED], null, null, null],
    startBlock: 0,
  });

  /** The naive answer: every Ping/Initialized log from an announced child, from its announcement. */
  async function naive() {
    const announcements = parseEventLogs({
      abi: factoryAbi,
      logs: await anvil.publicClient.getLogs({ address: factory, fromBlock: 0n, toBlock: BigInt(finalized) }),
      eventName: "ChildCreated",
    });
    const created = new Map(announcements.map((l) => [l.args.child.toLowerCase(), Number(l.blockNumber)]));
    const all = (await anvil.publicClient.request({
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: `0x${finalized.toString(16)}`, topics: [[PING, INITIALIZED]] }],
    } as never)) as { address: string; blockNumber: string; logIndex: string }[];
    return all
      .filter((l) => (created.get(l.address.toLowerCase()) ?? Infinity) <= Number.parseInt(l.blockNumber, 16))
      .map((l) => [Number.parseInt(l.blockNumber, 16), Number.parseInt(l.logIndex, 16)]);
  }

  it.each([
    ["by topic, filtered locally (5,000 children > 1,000)", 1_000],
    ["by address list", 10_000],
  ])(
    "caches exactly the children's logs, %s",
    async (_, maxAddressesPerFilter) => {
      const store = await freshStore();
      const proxy = await startRpcProxy({ target: anvil.rpcUrl, faults: { maxLogRange: 40 } });
      try {
        const pool = new RpcPool({ chainId: CHAIN, endpoints: [proxy.url] });
        const sync = () =>
          new HistoricalSync({ pool, store, sources: [source()], maxAddressesPerFilter }).run(finalized);
        const report = await sync();
        expect(report.incomplete).toBe(false);
        const children = await store.factoryChildren(CHAIN, factoryHash(source().factory));
        expect(children.size).toBe(CHILDREN);
        const ours = (await store.readFactoryLogs(source(), 0, finalized)).map((l) => [
          l.blockNumber,
          l.logIndex,
        ]);
        const expected = await naive();
        expect(ours).toEqual(expected);
        expect(ours.length).toBe(CHILDREN + 40); // every Initialized and every child Ping; never the stranger

        proxy.resetCalls();
        await sync();
        expect(proxy.totalCalls("eth_getLogs")).toBe(0);
      } finally {
        await proxy.stop();
        await sql.unsafe("truncate tm_sync.intervals, tm_sync.factory_children");
      }
    },
    300_000,
  );
});

describe("block interval sources", () => {
  it("caches the header of every interval block", async () => {
    const store = await freshStore();
    const pool = new RpcPool({ chainId: CHAIN, endpoints: [anvil.rpcUrl] });
    const spec = { kind: "block" as const, chainId: CHAIN, interval: 7, startBlock: 3 };
    await new HistoricalSync({ pool, store, sources: [spec] }).run(finalized);
    const numbers = Array.from({ length: Math.floor((finalized - 3) / 7) + 1 }, (_, i) => 3 + i * 7);
    const headers = await store.readBlocks(CHAIN, numbers);
    expect(headers.map((h) => h.number)).toEqual(numbers);
    for (const h of headers.slice(0, 5)) {
      const real = await anvil.publicClient.getBlock({ blockNumber: BigInt(h.number) });
      expect(h.hash).toBe(real.hash);
    }
  });
});

describe("trace sources", () => {
  it("keeps exactly the token transfer() calls whose effects stand", async () => {
    const store = await freshStore();
    const proxy = await startRpcProxy({ target: anvil.rpcUrl, faults: { maxLogRange: 25 } });
    try {
      const pool = new RpcPool({ chainId: CHAIN, endpoints: [proxy.url] });
      const spec: TraceSourceSpec = {
        kind: "trace",
        chainId: CHAIN,
        to: [lower(token)],
        selectors: [toFunctionSelector("transfer(address,uint256)")],
        startBlock: 0,
      };
      await new HistoricalSync({ pool, store, sources: [spec], maxLogRange: 2_000 }).run(finalized);
      const traces = await store.readTraces(spec, 0, finalized);
      const calls = traces.map((t) => {
        const { args } = decodeFunctionData({ abi: tokenAbi, data: t.input });
        const [to, value] = args as [Address, bigint];
        return [t.transactionHash, t.from, to.toLowerCase(), value.toString()].join(" ");
      });
      // Independent reference: every effective transfer() emitted exactly one Transfer (mints aside).
      const events = parseEventLogs({
        abi: tokenAbi,
        eventName: "Transfer",
        logs: await anvil.publicClient.getLogs({ address: token, fromBlock: 0n, toBlock: BigInt(finalized) }),
      })
        .filter((e) => e.args.from !== "0x0000000000000000000000000000000000000000")
        .map((e) =>
          [
            e.transactionHash,
            e.args.from.toLowerCase(),
            e.args.to.toLowerCase(),
            e.args.value.toString(),
          ].join(" "),
        );
      expect(calls.sort()).toEqual(events.sort());
      expect(calls.length).toBe(4); // direct, two of three forwarded, one nested
    } finally {
      await proxy.stop();
    }
  });
});
