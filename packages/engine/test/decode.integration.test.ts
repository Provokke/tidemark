/**
 * The engine's compiled event decoder against viem's decodeEventLog, on real logs of every shape
 * the Emitter fixture emits. They must agree exactly, except that the engine lowercases addresses.
 */
import { emitterAbi, emitterBytecode, tokenAbi } from "@tidemark/contracts";
import { type Anvil, startAnvil } from "@tidemark/testing";
import fc from "fast-check";
import {
  type AbiEvent,
  type Address,
  type Hex,
  decodeEventLog,
  getAddress,
  toEventSelector,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogShapeError, compileEventDecoder } from "../src/index.js";

let anvil: Anvil;
let emitter: Address;

beforeAll(async () => {
  anvil = await startAnvil();
  const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
  emitter = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
});
afterAll(async () => {
  await anvil.stop();
});

const events = emitterAbi.filter(
  (i): i is Extract<(typeof emitterAbi)[number], { type: "event" }> => i.type === "event",
);
const decoders = new Map(
  events
    .filter((e) => !e.anonymous)
    .map((e) => [
      toEventSelector(e as AbiEvent),
      { item: e as AbiEvent, decode: compileEventDecoder(e as AbiEvent) },
    ]),
);

/** viem's result with every checksummed address lowercased. */
function lowered(value: unknown): unknown {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && value === getAddress(value))
    return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowered);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lowered(v)]));
  return value;
}

async function checkTx(hash: Hex) {
  const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.logs.length).toBeGreaterThan(0);
  for (const log of receipt.logs) {
    const entry = decoders.get(log.topics[0] as Hex);
    if (entry === undefined) continue; // anonymous
    const ours = entry.decode(log.topics, log.data);
    const theirs = decodeEventLog({
      abi: [entry.item],
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    }).args;
    expect(ours).toEqual(lowered(theirs));
  }
}

const address = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => getAddress(toHex(b)));
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => toHex(b));
const uint256 = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n });
const int256 = fc.bigInt({ min: -(2n ** 255n), max: 2n ** 255n - 1n });
const text = fc.string({ unit: "grapheme", maxLength: 20 });
const pair = fc.record({ x: uint256, y: address });

describe("compiled event decoder", () => {
  it("matches viem on static events (the fast path)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 255 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        uint256,
        fc.integer({ min: -128, max: 127 }),
        int256,
        fc.boolean(),
        address,
        bytes32,
        fc.uint8Array({ minLength: 4, maxLength: 4 }).map((b) => toHex(b)),
        async (a, b, c, d, e, f, g, h, i) => {
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitAllStatic",
              args: [a, b, c, d, e, f, g, h, i],
            }),
          );
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitIndexedStatic",
              args: [c, f, h, e],
            }),
          );
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitSimple",
              args: [g, c],
            }),
          );
        },
      ),
      { numRuns: 15 },
    );
  });

  it("matches viem on dynamic, array, tuple and indexed-dynamic events", async () => {
    await fc.assert(
      fc.asyncProperty(
        text,
        fc.uint8Array({ maxLength: 40 }).map((b) => toHex(b)),
        fc.array(uint256, { maxLength: 3 }),
        fc.tuple(address, address, address),
        fc.array(text, { maxLength: 3 }),
        fc.array(fc.array(bytes32, { maxLength: 2 }), { maxLength: 2 }),
        pair,
        fc.record({ inner: pair, list: fc.array(pair, { maxLength: 3 }), label: text }),
        async (s, b, arr, fixedArr, strs, nested, p, n) => {
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitDynamic",
              args: [s, b],
            }),
          );
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitArrays",
              args: [arr, fixedArr, strs, nested],
            }),
          );
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitTuple",
              args: [p, n],
            }),
          );
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitIndexedDynamic",
              args: [s, b, arr],
            }),
          );
          await checkTx(
            await anvil.walletClient.writeContract({
              address: emitter,
              abi: emitterAbi,
              functionName: "emitIndexedTuple",
              args: [p, 7n],
            }),
          );
        },
      ),
      { numRuns: 15 },
    );
  });

  it("decodes events with no arguments and overloaded events", async () => {
    await checkTx(
      await anvil.walletClient.writeContract({
        address: emitter,
        abi: emitterAbi,
        functionName: "emitNoArgs",
      }),
    );
    await checkTx(
      await anvil.walletClient.writeContract({
        address: emitter,
        abi: emitterAbi,
        functionName: "emitOverloaded",
        args: [5n, "0x0000000000000000000000000000000000000006"],
      }),
    );
  });

  it("refuses a log of the same signature but a different shape (ERC-721 Transfer on an ERC-20 handler)", () => {
    const transfer = tokenAbi.find((i) => i.type === "event" && i.name === "Transfer") as AbiEvent;
    const decode = compileEventDecoder(transfer);
    const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    // ERC-721: tokenId indexed, so four topics and no data.
    expect(() => decode([toEventSelector(transfer), word(1), word(2), word(3)], "0x")).toThrow(LogShapeError);
    expect(decode([toEventSelector(transfer), word(1), word(2)], word(3))).toEqual({
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      value: 3n,
    });
    // Dirty padding in an address word is not a valid encoding.
    expect(() => decode([toEventSelector(transfer), `0x${"f".repeat(64)}`, word(2)], word(3))).toThrow(
      LogShapeError,
    );
  });
});
