/**
 * Verification modes in historical sync, against a node that silently answers ranges short. In
 * `head-check` mode the cache misses the left-out logs (no head check can see it); `bloom` repairs
 * them from the headers' blooms; `receipts-root` never asks `eth_getLogs` at all.
 */
import { normalizeLogFilter } from "@tidemark/core";
import { emitterAbi, emitterBytecode } from "@tidemark/contracts";
import { connect } from "@tidemark/pg";
import { RpcPool } from "@tidemark/rpc";
import { createTestDatabase, startAnvil, startRpcProxy } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import { HistoricalSync, SyncStore, verifyCache } from "../src/index.js";

it("bloom and receipts-root modes catch a node that leaves logs out", async () => {
  const anvil = await startAnvil();
  const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
  const emitter = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  for (let i = 0; i < 12; i++) {
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: emitter,
        abi: emitterAbi,
        functionName: "emitMany",
        args: [getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`), BigInt(1 + (i % 3))],
      }),
    });
    await anvil.testClient.mine({ blocks: 1 });
  }
  const head = Number(await anvil.publicClient.getBlockNumber());
  const filter = normalizeLogFilter({ chainId: 31_337, address: emitter.toLowerCase() as `0x${string}` });
  const truth = await new RpcPool({ chainId: 31_337, endpoints: [anvil.rpcUrl] }).getLogs(filter, 0, head);
  const blocks = [...new Set(truth.map((l) => l.blockNumber))];
  // The node leaves out three blocks' logs from every range answer.
  const proxy = await startRpcProxy({
    target: anvil.rpcUrl,
    faults: { omitLogsInBlocks: [blocks[1], blocks[5], blocks[9]] as number[] },
  });
  const db = await createTestDatabase();
  const sql = connect(db.url, { max: 4 });
  try {
    const syncWith = async (verify: "head-check" | "bloom" | "receipts-root") => {
      await sql.unsafe("drop schema if exists tm_sync cascade");
      await sql.unsafe("delete from tm_meta.migrations where namespace = 'sync'").catch(() => undefined);
      const store = new SyncStore(sql);
      await store.migrate();
      const repairs: number[] = [];
      proxy.resetCalls();
      await new HistoricalSync({
        pool: new RpcPool({ chainId: 31_337, endpoints: [proxy.url] }),
        store,
        sources: [{ filter, startBlock: 0 }],
        maxLogRange: 5,
        verify,
        onRepair: (e) => repairs.push(...e.blocks),
      }).run(head);
      const cached = await store.readLogs(filter, 0, head);
      return {
        cached: cached.map((l) => [l.blockNumber, l.logIndex]),
        repairs,
        getLogs: proxy.totalCalls("eth_getLogs"),
      };
    };
    const expected = truth.map((l) => [l.blockNumber, l.logIndex]);

    const trusting = await syncWith("head-check");
    expect(trusting.cached.length).toBeLessThan(expected.length); // what a short answer costs

    const bloom = await syncWith("bloom");
    expect(bloom.cached).toEqual(expected);
    expect(bloom.repairs.sort((a, b) => a - b)).toEqual([blocks[1], blocks[5], blocks[9]]);

    const receipts = await syncWith("receipts-root");
    expect(receipts.cached).toEqual(expected);
    expect(receipts.getLogs).toBe(0); // logs came from proven receipts only

    // An audit of a cache filled by the trusting mode: `tidemark verify` finds the three blocks,
    // repair forgets them, and a sync against an honest node fills them in.
    await syncWith("head-check");
    const store = new SyncStore(sql);
    const honest = new RpcPool({ chainId: 31_337, endpoints: [anvil.rpcUrl] });
    for (const mode of ["bloom", "receipts-root"] as const) {
      const [check] = await verifyCache(store, honest, {
        chainId: 31_337,
        from: 0,
        to: head,
        mode,
        chunk: 7,
      });
      expect(check?.badBlocks).toEqual([blocks[1], blocks[5], blocks[9]]);
    }
    await verifyCache(store, honest, { chainId: 31_337, from: 0, to: head, mode: "bloom", repair: true });
    await new HistoricalSync({ pool: honest, store, sources: [{ filter, startBlock: 0 }] }).run(head);
    expect((await store.readLogs(filter, 0, head)).map((l) => [l.blockNumber, l.logIndex])).toEqual(expected);
    const [clean] = await verifyCache(store, honest, {
      chainId: 31_337,
      from: 0,
      to: head,
      mode: "receipts-root",
    });
    expect(clean?.badBlocks).toEqual([]);
    expect(clean?.blocksChecked).toBe(head + 1);

    // A forged log in the cache (data the chain never had) is found too.
    await sql.unsafe(
      `update tm_sync.logs set data = decode('ff', 'hex') where block_number = ${blocks[3] as number}`,
    );
    const [forged] = await verifyCache(store, honest, {
      chainId: 31_337,
      from: 0,
      to: head,
      mode: "receipts-root",
    });
    expect(forged?.badBlocks).toEqual([blocks[3]]);
  } finally {
    await sql.end();
    await db.drop();
    await proxy.stop();
    await anvil.stop();
  }
}, 120_000);
