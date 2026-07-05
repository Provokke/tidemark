/**
 * create-tidemark end to end: scaffold from a verified contract (a stand-in Sourcify serves the
 * ABI) and from the ERC-20 template, check the generated code type-checks against the typed
 * registry, and index both on Anvil.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadProject, main as tidemark } from "@tidemark/cli";
import { emitterAbi, emitterBytecode, tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { runIndexer } from "@tidemark/engine";
import { connect } from "@tidemark/pg";
import { type Anvil, type TestDatabase, createTestDatabase, startAnvil } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { create, fetchAbi } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const tsc = join(here, "..", "node_modules", ".bin", "tsc");
const work = join(here, ".work", randomUUID());

let anvil: Anvil;
let db: TestDatabase;
let sourcify: Server;
let sourcifyUrl: string;
let etherscan: Server;
let etherscanUrl: string;
let emitter: Address;
const etherscanRequests: string[] = [];

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  anvil = await startAnvil();
  db = await createTestDatabase();
  const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
  emitter = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;

  sourcify = createServer((req, res) => {
    if (req.url?.startsWith(`/v2/contract/31337/${emitter}`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ abi: emitterAbi, compilation: { name: "Emitter" } }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ customCode: "not_found" }));
    }
  });
  sourcifyUrl = await listen(sourcify);
  etherscan = createServer((req, res) => {
    etherscanRequests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      url.searchParams.get("apikey") === "good"
        ? JSON.stringify({ status: "1", message: "OK", result: JSON.stringify(tokenAbi) })
        : JSON.stringify({ status: "0", message: "NOTOK", result: "Invalid API Key" }),
    );
  });
  etherscanUrl = await listen(etherscan);
  await mkdir(work, { recursive: true });
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  sourcify.close();
  etherscan.close();
  await db.drop();
  await anvil.stop();
});

describe("fetchAbi", () => {
  it("uses Sourcify, then Etherscan, and explains what failed", async () => {
    const fromSourcify = await fetchAbi(31_337, emitter, { sourcifyUrl });
    expect(fromSourcify).toMatchObject({ source: "sourcify", name: "Emitter" });
    const other = getAddress("0x00000000000000000000000000000000000000aa");
    const fromEtherscan = await fetchAbi(31_337, other, {
      sourcifyUrl,
      etherscanUrl,
      etherscanApiKey: "good",
    });
    expect(fromEtherscan.source).toBe("etherscan");
    expect(etherscanRequests.at(-1)).toContain("chainid=31337");
    await expect(
      fetchAbi(31_337, other, { sourcifyUrl, etherscanUrl, etherscanApiKey: "bad" }),
    ).rejects.toThrow(/Sourcify: HTTP 404[\s\S]*Etherscan: Invalid API Key/);
    await expect(fetchAbi(31_337, "0x123", { sourcifyUrl })).rejects.toThrow(/not an address/);
  });
});

describe("create-tidemark", () => {
  it("scaffolds from a verified contract; the project type-checks and indexes every event", async () => {
    const dir = join(work, "emitter-indexer");
    const lines: string[] = [];
    const code = await create([dir, "--address", emitter, "--chain-id", "31337"], {
      sources: { sourcifyUrl },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("fetched the ABI from sourcify (Emitter)");
    expect(lines.join("\n")).toContain("skipped Emitter:AnonymousFour");

    // Generated code against the generated registry types.
    expect(
      await tidemark(["codegen", "--root", dir], { io: { out: () => undefined, err: () => undefined } }),
    ).toBe(0);
    await expect(run(tsc, ["--noEmit", "-p", dir])).resolves.toBeDefined();

    // Emit one of every event, then index.
    const call = async (functionName: string, args: readonly unknown[]) =>
      anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.walletClient.writeContract({
          address: emitter,
          abi: emitterAbi,
          functionName,
          args,
        } as never),
      });
    const someone = getAddress("0x00000000000000000000000000000000000000b0");
    await call("emitNoArgs", []);
    await call("emitSimple", [someone, 42n]);
    await call("emitAllStatic", [
      255,
      2n ** 64n - 1n,
      2n ** 256n - 1n,
      -128,
      -(2n ** 255n),
      true,
      someone,
      `0x${"ab".repeat(32)}`,
      "0xdeadbeef",
    ]);
    await call("emitDynamic", ["héllo", "0x0102"]);
    await call("emitArrays", [
      [1n, 2n ** 200n],
      [someone, someone, someone],
      ["a", "b"],
      [[`0x${"11".repeat(32)}`]],
    ]);
    await call("emitTuple", [
      { x: 1n, y: someone },
      { inner: { x: 2n, y: someone }, list: [{ x: 3n, y: someone }], label: "n" },
    ]);
    await call("emitIndexedDynamic", ["s", "0x01", [1n]]);
    await call("emitIndexedTuple", [{ x: 1n, y: someone }, 9n]);
    await call("emitIndexedStatic", [7n, true, `0x${"cd".repeat(32)}`, -5n]);
    await call("emitAnonymousFour", [1n, 2n, 3n, 4n, "e"]);
    await call("emitOverloaded", [5n, someone]);
    await anvil.testClient.mine({ blocks: 64 });

    process.env.ANVIL_RPC_URL = anvil.rpcUrl;
    const project = await loadProject(dir);
    const sql = connect(db.url, { max: 4 });
    try {
      await runIndexer({ tidemark: project.tidemark, schema: project.schema, sql, indexSchema: "emitter" });
      const count = async (table: string) =>
        Number(
          (await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from emitter."${table}"`))[0]?.n,
        );
      for (const table of [
        "emitter_no_args",
        "emitter_simple",
        "emitter_all_static",
        "emitter_dynamic",
        "emitter_arrays",
        "emitter_tuple",
        "emitter_indexed_dynamic",
        "emitter_indexed_tuple",
        "emitter_indexed_static",
        "emitter_overloaded_uint256",
        "emitter_overloaded_address",
      ]) {
        expect({ table, rows: await count(table) }).toEqual({ table, rows: 1 });
      }
      const [stat] = await sql.unsafe<
        { a: number; b: string; c: string; d: number; e: string; f: boolean }[]
      >(`select a, b::text, c::text, d, e::text, f from emitter.emitter_all_static`);
      expect(stat).toEqual({
        a: 255,
        b: (2n ** 64n - 1n).toString(),
        c: (2n ** 256n - 1n).toString(),
        d: -128,
        e: (-(2n ** 255n)).toString(),
        f: true,
      });
      const [arrays] = await sql.unsafe<{ dyn: unknown }[]>(`select dyn from emitter.emitter_arrays`);
      expect(arrays?.dyn).toEqual(["1", (2n ** 200n).toString()]);
      const [dynamic] = await sql.unsafe<{ s: string }[]>(`select s from emitter.emitter_dynamic`);
      expect(dynamic?.s).toBe("héllo");
    } finally {
      await sql.end();
    }
  }, 120_000);

  it("scaffolds the ERC-20 template; it type-checks and indexes balances", async () => {
    const dir = join(work, "token-indexer");
    expect(await create([dir, "--chain-id", "31337"], { log: () => undefined })).toBe(0);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@tidemark/cli"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(
      await tidemark(["codegen", "--root", dir], { io: { out: () => undefined, err: () => undefined } }),
    ).toBe(0);
    await expect(run(tsc, ["--noEmit", "-p", dir])).resolves.toBeDefined();

    const hash = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
    const token = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
    const me = anvil.walletClient.account.address;
    const send = async (functionName: "mint" | "transfer" | "approve", to: Address, amount: bigint) =>
      anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.walletClient.writeContract({
          address: token,
          abi: tokenAbi,
          functionName,
          args: [to, amount],
        }),
      });
    const alice = getAddress("0x00000000000000000000000000000000000a11ce");
    await send("mint", me, 1000n);
    await send("transfer", alice, 300n);
    await send("approve", alice, 50n);
    await anvil.testClient.mine({ blocks: 64 });

    process.env.ANVIL_RPC_URL = anvil.rpcUrl;
    process.env.TOKEN_ADDRESS = token;
    const project = await loadProject(dir);
    const sql = connect(db.url, { max: 4 });
    try {
      await runIndexer({ tidemark: project.tidemark, schema: project.schema, sql, indexSchema: "token" });
      const balances = await sql.unsafe<{ id: Buffer; balance: string }[]>(
        `select id, balance::text from token.account`,
      );
      const byId = Object.fromEntries(balances.map((b) => [`0x${b.id.toString("hex")}`, b.balance]));
      expect(byId).toEqual({ [me.toLowerCase()]: "700", [alice.toLowerCase()]: "300" });
      const [allowance] = await sql.unsafe<{ value: string }[]>(`select value::text from token.allowance`);
      expect(allowance?.value).toBe("50");
    } finally {
      await sql.end();
    }
  }, 120_000);

  it("refuses to write into a directory that is not empty", async () => {
    const lines: string[] = [];
    expect(await create([join(work, "token-indexer")], { log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join("")).toContain("not empty");
  });
});
