/**
 * Verification against real headers. Anvil blocks with every receipt shape it produces (legacy,
 * EIP-2930, EIP-1559 and EIP-7702 transactions; reverted ones; a block of 40 transactions, so the
 * receipts trie has branch and extension nodes; empty blocks) must prove out, and tampering must not.
 */
import { normalizeLogFilter } from "@tidemark/core";
import { emitterAbi, emitterBytecode, tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { type Anvil, type RpcProxy, startAnvil, startRpcProxy } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RpcBlockHeader,
  RpcPool,
  VerificationError,
  encodeReceipt,
  logsBloom,
  logsFromVerifiedReceipts,
  orderedTrieRoot,
  verifiedReceipts,
  verifyLogsWithBloom,
} from "../src/index.js";

let anvil: Anvil;
let proxy: RpcProxy;
let token: Address;
let emitter: Address;
let head: number;

const pool = (url: string) => new RpcPool({ chainId: 31_337, endpoints: [url], timeoutMs: 5_000 });

beforeAll(async () => {
  anvil = await startAnvil();
  const w = anvil.walletClient;
  const wait = async (hash: Promise<`0x${string}`>) =>
    anvil.publicClient.waitForTransactionReceipt({ hash: await hash });
  token = (await wait(w.deployContract({ abi: tokenAbi, bytecode: tokenBytecode })))
    .contractAddress as Address;
  emitter = (await wait(w.deployContract({ abi: emitterAbi, bytecode: emitterBytecode })))
    .contractAddress as Address;
  const me = w.account.address;
  await wait(
    w.writeContract({ address: token, abi: tokenAbi, functionName: "mint", args: [me, 10n ** 24n] }),
  );
  const someone = getAddress("0x00000000000000000000000000000000000000b0");

  // One transaction of each type, then a reverted one (gas given, so it is sent anyway).
  await wait(w.sendTransaction({ to: someone, value: 1n, type: "legacy", gasPrice: 2_000_000_000n }));
  await wait(
    w.sendTransaction({
      to: someone,
      value: 1n,
      type: "eip2930",
      gasPrice: 2_000_000_000n,
      accessList: [{ address: token, storageKeys: [] }],
    }),
  );
  await wait(
    w.writeContract({ address: token, abi: tokenAbi, functionName: "transfer", args: [someone, 5n] }),
  );
  const authorization = await w.signAuthorization({ contractAddress: emitter, executor: "self" });
  // The account runs the Emitter's code for this call: a type-4 receipt with a log in it.
  await wait(
    w.writeContract({
      address: me,
      abi: emitterAbi,
      functionName: "emitNoArgs",
      authorizationList: [authorization],
    }),
  );
  await wait(
    w.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "transfer",
      args: [someone, 10n ** 30n],
      gas: 100_000n,
    }),
  );
  await wait(
    w.writeContract({ address: emitter, abi: emitterAbi, functionName: "emitMany", args: [someone, 50n] }),
  );

  // Forty transactions in one block.
  await anvil.testClient.setAutomine(false);
  const hashes: `0x${string}`[] = [];
  for (let i = 0; i < 40; i++) {
    hashes.push(
      await w.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: "transfer",
        args: [getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`), BigInt(i + 1)],
        gas: 80_000n,
      }),
    );
  }
  await anvil.testClient.mine({ blocks: 1 });
  await anvil.testClient.setAutomine(true);
  for (const h of hashes) await anvil.publicClient.waitForTransactionReceipt({ hash: h });
  await anvil.testClient.mine({ blocks: 2 }); // empty blocks
  head = Number(await anvil.publicClient.getBlockNumber());
  proxy = await startRpcProxy({ target: anvil.rpcUrl });
}, 60_000);

afterAll(async () => {
  await proxy.stop();
  await anvil.stop();
});

describe("receipts root and bloom", () => {
  it("rebuilds every block's receipts root and bloom from its receipts", async () => {
    const p = pool(anvil.rpcUrl);
    const headers = await p.getBlockHeaders(Array.from({ length: head + 1 }, (_, i) => i));
    const types = new Set<string>();
    let biggest = 0;
    for (const header of headers) {
      const receipts = await verifiedReceipts(p, header);
      for (const r of receipts) types.add(`${r.type ?? "0x0"}:${r.status ?? "?"}`);
      biggest = Math.max(biggest, receipts.length);
    }
    // The fixture really has the shapes it claims.
    expect([...types].sort()).toEqual(["0x0:0x1", "0x1:0x1", "0x2:0x0", "0x2:0x1", "0x4:0x1"]);
    expect(biggest).toBe(40);
  });

  it("refuses receipts that do not match the header", async () => {
    const p = pool(anvil.rpcUrl);
    const [header] = await p.getBlockHeaders([head - 2]); // the 40-transaction block
    const receipts = await verifiedReceipts(p, header as never);
    const good = orderedTrieRoot(receipts.map(encodeReceipt));
    expect(good).toBe(header?.receiptsRoot);
    // Any change to any receipt changes the root: drop a log, change gas, reorder two receipts.
    const dropLog = receipts.map((r, i) => (i === 7 ? { ...r, logs: [] } : r));
    const moreGas = receipts.map((r, i) =>
      i === 39 ? { ...r, cumulativeGasUsed: `0x${(BigInt(r.cumulativeGasUsed) + 1n).toString(16)}` } : r,
    );
    const swapped = [receipts[1], receipts[0], ...receipts.slice(2)] as typeof receipts;
    for (const tampered of [dropLog, moreGas, swapped])
      expect(orderedTrieRoot(tampered.map(encodeReceipt))).not.toBe(good);
    expect(logsBloom(dropLog.flatMap((r) => r.logs))).not.toBe(header?.logsBloom);
    // A header whose root does not match is an error.
    await expect(
      verifiedReceipts(p, { ...(header as RpcBlockHeader), receiptsRoot: `0x${"00".repeat(32)}` }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  it("derives the same logs from proven receipts as eth_getLogs returns", async () => {
    const p = pool(anvil.rpcUrl);
    for (const address of [token, emitter]) {
      const filter = normalizeLogFilter({ chainId: 31_337, address: address.toLowerCase() as `0x${string}` });
      const viaReceipts = await logsFromVerifiedReceipts(p, filter, 0, head);
      const viaGetLogs = await p.getLogs(filter, 0, head);
      expect(viaReceipts.map((l) => [l.blockNumber, l.logIndex, l.topics, l.data])).toEqual(
        viaGetLogs.map((l) => [l.blockNumber, l.logIndex, l.topics, l.data]),
      );
      expect(viaReceipts.length).toBeGreaterThan(0);
    }
  });
});

describe("bloom mode", () => {
  it("repairs a range answer that left blocks out, and refuses logs a block cannot contain", async () => {
    const filter = normalizeLogFilter({ chainId: 31_337, address: token.toLowerCase() as `0x${string}` });
    const honest = await pool(anvil.rpcUrl).getLogs(filter, 0, head);
    const blocksWithLogs = [...new Set(honest.map((l) => l.blockNumber))];
    proxy.faults = { omitLogsInBlocks: blocksWithLogs.slice(0, 2) };
    const p = pool(proxy.url);
    const short = await p.getLogs(filter, 0, head);
    expect(short.length).toBeLessThan(honest.length); // the node did answer short
    const { logs, report } = await verifyLogsWithBloom(p, filter, 0, head, short);
    expect(report.repaired).toEqual(blocksWithLogs.slice(0, 2));
    expect(logs.map((l) => [l.blockNumber, l.logIndex])).toEqual(
      honest.map((l) => [l.blockNumber, l.logIndex]),
    );

    // A log the header's bloom rules out is not on the chain.
    const forged = {
      ...(honest[0] as (typeof honest)[number]),
      address: "0x000000000000000000000000000000000000dead" as const,
    };
    await expect(verifyLogsWithBloom(p, filter, 0, head, [forged, ...honest.slice(1)])).rejects.toThrow(
      /not in the header's bloom/,
    );
    // So is one that names another block's hash.
    const moved = { ...(honest[0] as (typeof honest)[number]), blockHash: `0x${"11".repeat(32)}` as const };
    await expect(verifyLogsWithBloom(p, filter, 0, head, [moved, ...honest.slice(1)])).rejects.toThrow(
      /names block/,
    );
    proxy.faults = {};
  });
});
