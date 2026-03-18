/** Cache export and import: to a directory and to S3; a fresh database seeded from it syncs with no RPC. */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLogFilter, signV4 } from "@tidemark/core";
import { emitterAbi, emitterBytecode } from "@tidemark/contracts";
import { type Sql, connect } from "@tidemark/pg";
import { RpcPool } from "@tidemark/rpc";
import { createTestDatabase, startAnvil, startRpcProxy } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import {
  HistoricalSync,
  SyncStore,
  directoryStorage,
  exportCache,
  importCache,
  s3Storage,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

it("exports the cache and seeds a fresh database from it, through a directory and S3", async () => {
  const anvil = await startAnvil();
  const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
  const emitter = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  for (let i = 0; i < 6; i++) {
    await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: emitter,
        abi: emitterAbi,
        functionName: "emitMany",
        args: [getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`), 3n],
      }),
    });
  }
  const head = Number(await anvil.publicClient.getBlockNumber());
  const filter = normalizeLogFilter({ chainId: 31_337, address: emitter.toLowerCase() as `0x${string}` });
  const proxy = await startRpcProxy({ target: anvil.rpcUrl });
  const dbs = await Promise.all([createTestDatabase(), createTestDatabase(), createTestDatabase()]);
  const sqls = dbs.map((d) => connect(d.url, { max: 4 })) as [Sql, Sql, Sql];
  const dir = join(here, ".work", randomUUID());

  // The S3 stand-in: keeps objects in memory and checks every request's SigV4 signature itself.
  const objects = new Map<string, Buffer>();
  const credentials = { accessKeyId: "AKIDTEST", secretAccessKey: "secret-test-key" };
  let badSignatures = 0;
  const s3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const date = req.headers["x-amz-date"] as string;
      const expected = signV4({
        method: req.method ?? "GET",
        url,
        headers: { "x-amz-content-sha256": req.headers["x-amz-content-sha256"] as string },
        body,
        region: "eu-west-1",
        service: "s3",
        credentials,
        date: new Date(
          `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
        ),
      });
      const payloadOk =
        req.headers["x-amz-content-sha256"] === createHash("sha256").update(body).digest("hex");
      if (expected.authorization !== req.headers.authorization || !payloadOk) {
        badSignatures++;
        res.writeHead(403).end("SignatureDoesNotMatch");
        return;
      }
      if (req.method === "PUT") {
        objects.set(url.pathname, body);
        res.writeHead(200).end();
      } else {
        const object = objects.get(url.pathname);
        if (object === undefined) res.writeHead(404).end();
        else res.writeHead(200).end(object);
      }
    });
  });
  await new Promise<void>((r) => s3.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;

  try {
    const [a, b, c] = sqls.map((s) => new SyncStore(s)) as [SyncStore, SyncStore, SyncStore];
    await a.migrate();
    await new HistoricalSync({
      pool: new RpcPool({ chainId: 31_337, endpoints: [anvil.rpcUrl] }),
      store: a,
      sources: [{ filter, startBlock: 0 }],
      maxLogRange: 4,
    }).run(head);
    await a.putCachedRead(31_337, head, "req-hash", { answer: "0x2a" });
    const logs = await a.readLogs(filter, 0, head);
    expect(logs.length).toBe(18);

    const seededSyncsWithoutRpc = async (store: SyncStore) => {
      expect(await store.readLogs(filter, 0, head)).toEqual(logs);
      expect(await store.getCachedRead(31_337, head, "req-hash")).toEqual({ answer: "0x2a" });
      proxy.resetCalls();
      await new HistoricalSync({
        pool: new RpcPool({ chainId: 31_337, endpoints: [proxy.url] }),
        store,
        sources: [{ filter, startBlock: 0 }],
      }).run(head);
      expect(proxy.totalCalls("eth_getLogs")).toBe(0);
    };

    // A directory.
    const manifest = await exportCache(a, directoryStorage(dir));
    expect(manifest.parts.logs?.[0]?.rows).toBe(18);
    await importCache(b, directoryStorage(dir));
    await seededSyncsWithoutRpc(b);
    // Importing again changes nothing.
    await importCache(b, directoryStorage(dir));
    expect((await b.readLogs(filter, 0, head)).length).toBe(18);
    // A damaged part is refused before anything from it is written.
    await writeFile(join(dir, manifest.parts.logs?.[0]?.key ?? ""), "not gzip");
    await expect(importCache(c, directoryStorage(dir))).rejects.toThrow(/checksum mismatch/);

    // S3 (path-style, as MinIO and other S3-compatible stores take it).
    const bucket = s3Storage({
      bucket: "caches",
      prefix: "chain-31337/2026-11",
      region: "eu-west-1",
      endpoint,
      credentials,
    });
    await exportCache(a, bucket);
    expect([...objects.keys()]).toContain("/caches/chain-31337/2026-11/manifest.json");
    await importCache(c, bucket);
    await seededSyncsWithoutRpc(c);
    expect(badSignatures).toBe(0);
  } finally {
    s3.close();
    await rm(dir, { recursive: true, force: true });
    for (const s of sqls) await s.end();
    for (const d of dbs) await d.drop();
    await proxy.stop();
    await anvil.stop();
  }
}, 120_000);
