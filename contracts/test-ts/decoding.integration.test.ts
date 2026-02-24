/**
 * Every ABI shape the fixture contracts emit goes through a real
 * chain (Anvil), comes back through `eth_getLogs` as the indexer will fetch it, and decodes to
 * exactly the values that were sent. Indexed dynamic values decode to the hash the EVM stores.
 */
import { type Anvil, startAnvil } from "@tidemark/testing";
import fc from "fast-check";
import {
  type Address,
  type Hex,
  type Log,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  pad,
  parseEventLogs,
  toBytes,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitterAbi, emitterBytecode, factoryAbi, factoryBytecode } from "../ts/index.js";

const RUNS = 25;

let anvil: Anvil;
let emitter: Address;
let factory: Address;

async function deploy(abi: typeof emitterAbi | typeof factoryAbi, bytecode: Hex): Promise<Address> {
  const hash = await anvil.walletClient.deployContract({ abi, bytecode });
  const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress == null) throw new Error("deployment produced no contract address");
  return receipt.contractAddress;
}

/** Fetches a transaction's logs the way the indexer will: `eth_getLogs` over its block. */
async function logsOf(hash: Hex, address?: Address): Promise<Log[]> {
  const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  const logs = await anvil.publicClient.getLogs({
    ...(address === undefined ? {} : { address }),
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  return logs.filter((log) => log.transactionHash === hash);
}

async function emitterLogs(hash: Hex) {
  return parseEventLogs({ abi: emitterAbi, logs: await logsOf(hash, emitter) });
}

const address = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((bytes) => getAddress(toHex(bytes)));
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => toHex(bytes));
const bytes4 = fc.uint8Array({ minLength: 4, maxLength: 4 }).map((bytes) => toHex(bytes));
const uint256 = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n });
const int256 = fc.bigInt({ min: -(2n ** 255n), max: 2n ** 255n - 1n });
// Solidity strings are UTF-8 bytes; graphemes are always valid Unicode, so they round-trip.
const text = fc.string({ unit: "grapheme", maxLength: 40 });
const bytes = fc.uint8Array({ maxLength: 100 }).map((b) => toHex(b));
const pair = fc.record({ x: uint256, y: address });

beforeAll(async () => {
  anvil = await startAnvil();
  emitter = await deploy(emitterAbi, emitterBytecode);
  factory = await deploy(factoryAbi, factoryBytecode);
});

afterAll(async () => {
  await anvil.stop();
});

describe("event decoding through a real chain", () => {
  it("NoArgs", async () => {
    const hash = await anvil.walletClient.writeContract({
      address: emitter,
      abi: emitterAbi,
      functionName: "emitNoArgs",
    });
    const [log] = await emitterLogs(hash);
    expect(log?.eventName).toBe("NoArgs");
  });

  it("Simple: indexed addresses and a value", async () => {
    await fc.assert(
      fc.asyncProperty(address, uint256, async (to, value) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitSimple",
          args: [to, value],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.eventName).toBe("Simple");
        expect(log?.args).toEqual({ from: anvil.walletClient.account.address, to, value });
      }),
      { numRuns: RUNS },
    );
  });

  it("several logs in one transaction keep their order and log indexes", async () => {
    const hash = await anvil.walletClient.writeContract({
      address: emitter,
      abi: emitterAbi,
      functionName: "emitMany",
      args: ["0x000000000000000000000000000000000000bEEF", 6n],
    });
    const logs = await emitterLogs(hash);
    expect(logs.map((log) => log.args)).toEqual(
      [0n, 1n, 2n, 3n, 4n, 5n].map((value) => ({
        from: anvil.walletClient.account.address,
        to: "0x000000000000000000000000000000000000bEEF",
        value,
      })),
    );
    const indexes = logs.map((log) => log.logIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(6);
  });

  it("AllStatic: every static type, including both ends of every range", async () => {
    const arb = fc.record({
      a: fc.integer({ min: 0, max: 255 }),
      b: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      c: uint256,
      d: fc.integer({ min: -128, max: 127 }),
      e: int256,
      f: fc.boolean(),
      g: address,
      h: bytes32,
      i: bytes4,
    });
    type Args = typeof arb extends fc.Arbitrary<infer T> ? T : never;
    const edges = [
      [0, 0n, 0n, -128, -(2n ** 255n), false],
      [255, 2n ** 64n - 1n, 2n ** 256n - 1n, 127, 2n ** 255n - 1n, true],
    ] as const;
    const examples = edges.map(([a, b, c, d, e, f]): [Args] => [
      {
        a,
        b,
        c,
        d,
        e,
        f,
        g: getAddress("0x0000000000000000000000000000000000000001"),
        h: pad("0x01"),
        i: "0xffffffff",
      },
    ]);
    await fc.assert(
      fc.asyncProperty(arb, async (v) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitAllStatic",
          args: [v.a, v.b, v.c, v.d, v.e, v.f, v.g, v.h, v.i],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.eventName).toBe("AllStatic");
        expect(log?.args).toEqual(v);
      }),
      { numRuns: RUNS, examples },
    );
  });

  it("Dynamic: string and bytes, including empty and multi-byte UTF-8", async () => {
    await fc.assert(
      fc.asyncProperty(text, bytes, async (s, b) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitDynamic",
          args: [s, b],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.args).toEqual({ s, b });
      }),
      {
        numRuns: RUNS,
        examples: [
          ["", "0x"],
          ["héllo 👋🏽 世界", "0x00ff"],
        ],
      },
    );
  });

  it("Arrays: dynamic, fixed, string and nested arrays", async () => {
    const arb = fc.record({
      dyn: fc.array(uint256, { maxLength: 5 }),
      fixedArr: fc.tuple(address, address, address),
      strs: fc.array(text, { maxLength: 4 }),
      nested: fc.array(fc.array(bytes32, { maxLength: 3 }), { maxLength: 3 }),
    });
    await fc.assert(
      fc.asyncProperty(arb, async (v) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitArrays",
          args: [v.dyn, v.fixedArr, v.strs, v.nested],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.args).toEqual(v);
      }),
      { numRuns: RUNS },
    );
  });

  it("Tuple: structs nested in structs and in arrays", async () => {
    const arb = fc.record({
      p: pair,
      n: fc.record({ inner: pair, list: fc.array(pair, { maxLength: 4 }), label: text }),
    });
    await fc.assert(
      fc.asyncProperty(arb, async (v) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitTuple",
          args: [v.p, v.n],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.args).toEqual(v);
      }),
      { numRuns: RUNS },
    );
  });

  it("IndexedDynamic: indexed string, bytes and array decode to their keccak256", async () => {
    await fc.assert(
      fc.asyncProperty(text, bytes, fc.array(uint256, { maxLength: 4 }), async (s, b, arr) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitIndexedDynamic",
          args: [s, b, arr],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.args).toEqual({
          s: keccak256(toBytes(s)),
          b: keccak256(b),
          // An indexed array's topic hashes its elements, each padded to a 32-byte word.
          arr: keccak256(concat(arr.map((x) => pad(toHex(x))))),
        });
      }),
      { numRuns: RUNS },
    );
  });

  it("IndexedTuple: an indexed struct decodes to the keccak256 of its ABI encoding", async () => {
    await fc.assert(
      fc.asyncProperty(pair, uint256, async (p, tag) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitIndexedTuple",
          args: [p, tag],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.args).toEqual({
          p: keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [p.x, p.y])),
          tag,
        });
      }),
      { numRuns: RUNS },
    );
  });

  it("IndexedStatic: three indexed static values and one in data", async () => {
    await fc.assert(
      fc.asyncProperty(uint256, fc.boolean(), bytes32, int256, async (a, b, c, d) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitIndexedStatic",
          args: [a, b, c, d],
        });
        const [log] = await emitterLogs(hash);
        expect(log?.args).toEqual({ a, b, c, d });
      }),
      { numRuns: RUNS },
    );
  });

  it("AnonymousFour: has no signature topic, so a signature-based decoder must skip it", async () => {
    await fc.assert(
      fc.asyncProperty(uint256, uint256, uint256, uint256, text, async (a, b, c, d, e) => {
        const hash = await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName: "emitAnonymousFour",
          args: [a, b, c, d, e],
        });
        const [raw] = await logsOf(hash, emitter);
        if (raw === undefined) throw new Error("no log");

        // Four topics, all of them values: nothing identifies the event.
        expect(raw.topics.map((topic) => hexToBigInt(topic))).toEqual([a, b, c, d]);
        expect(decodeAbiParameters([{ type: "string" }], raw.data)).toEqual([e]);
        expect(parseEventLogs({ abi: emitterAbi, logs: [raw] })).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it("Overloaded: same name, different signatures, decoded by their own types", async () => {
    const hash = await anvil.walletClient.writeContract({
      address: emitter,
      abi: emitterAbi,
      functionName: "emitOverloaded",
      args: [5n, "0x0000000000000000000000000000000000000006"],
    });
    const logs = await emitterLogs(hash);
    expect(logs.map((log) => [log.eventName, log.args])).toEqual([
      ["Overloaded", { value: 5n }],
      ["Overloaded", { value: "0x0000000000000000000000000000000000000006" }],
    ]);
    expect(logs[0]?.topics[0]).toBe(keccak256(toBytes("Overloaded(uint256)")));
    expect(logs[1]?.topics[0]).toBe(keccak256(toBytes("Overloaded(address)")));
  });
});

describe("factory fixtures", () => {
  it("a child's first log precedes the factory log that announces it", async () => {
    const salt = pad("0x01");
    const predicted = await anvil.publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "predict",
      args: [salt, "first"],
    });
    const hash = await anvil.walletClient.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: "createChild",
      args: [salt, "first"],
    });

    const logs = await logsOf(hash);
    expect(logs.map((log) => getAddress(log.address))).toEqual([predicted, getAddress(factory)]);
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "ChildCreated" });
    expect(created?.args).toEqual({ child: predicted, salt, label: "first" });
    const [first, second] = logs;
    expect(first?.logIndex).toBeLessThan(second?.logIndex ?? -1);
  });
});
