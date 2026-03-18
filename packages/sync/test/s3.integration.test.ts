/**
 * The S3 archive against a real S3 implementation (MinIO in CI). Set TIDEMARK_TEST_S3_ENDPOINT,
 * with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for it, to run.
 */
import { createHash, randomUUID } from "node:crypto";
import { signV4 } from "@tidemark/core";
import { connect } from "@tidemark/pg";
import { createTestDatabase } from "@tidemark/testing";
import { describe, expect, it } from "vitest";
import { SyncStore, exportCache, importCache, s3Storage } from "../src/index.js";

const endpoint = process.env.TIDEMARK_TEST_S3_ENDPOINT;

describe.skipIf(endpoint === undefined)("S3 archive (real S3)", () => {
  it("round-trips the cache through a bucket", async () => {
    const credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    };
    const bucket = `tidemark-${randomUUID().slice(0, 8)}`;
    // CreateBucket: a signed PUT on the bucket itself.
    const url = new URL(`${endpoint as string}/${bucket}`);
    const headers = signV4({
      method: "PUT",
      url,
      headers: { "x-amz-content-sha256": createHash("sha256").update("").digest("hex") },
      body: "",
      region: "us-east-1",
      service: "s3",
      credentials,
    });
    delete headers.host;
    expect((await fetch(url, { method: "PUT", headers })).status).toBe(200);

    const dbs = await Promise.all([createTestDatabase(), createTestDatabase()]);
    const [a, b] = dbs.map((d) => connect(d.url, { max: 2 }));
    try {
      const source = new SyncStore(a as never);
      await source.migrate();
      await source.putCachedRead(1, 100, "k", { v: 1 });
      const storage = s3Storage({
        bucket,
        prefix: "archives/x",
        region: "us-east-1",
        endpoint: endpoint as string,
        credentials,
      });
      await exportCache(source, storage, { chains: [1] });
      const target = new SyncStore(b as never);
      await importCache(target, storage);
      expect(await target.getCachedRead(1, 100, "k")).toEqual({ v: 1 });
    } finally {
      await a?.end();
      await b?.end();
      for (const d of dbs) await d.drop();
    }
  });
});
