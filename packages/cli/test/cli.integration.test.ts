/**
 * The CLI end to end, on a copy of a small project: codegen (and the types it generates), database
 * setup, `dev` with hot reload from the sync cache, a broken save, builds and rollback.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import {
  type Anvil,
  type RpcProxy,
  type TestDatabase,
  createTestDatabase,
  startAnvil,
  startRpcProxy,
} from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Io, main } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const recipients = Array.from({ length: 3 }, (_, i) =>
  getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
);

let anvil: Anvil;
let proxy: RpcProxy;
let db: TestDatabase;
let project: string;
let rangedGetLogs = 0;

function capture(): Io & { lines: string[]; out: (l: string) => void } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
}

const cli = async (...args: string[]) => {
  const io = capture();
  const code = await main([...args, "--root", project, "--database-url", db.url], { io });
  return { code, output: io.lines.join("\n") };
};

beforeAll(async () => {
  anvil = await startAnvil();
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
  await send("mint", anvil.walletClient.account.address, 10n ** 21n);
  for (const [i, to] of recipients.entries()) await send("transfer", to, BigInt(i + 1) * 100n);
  await anvil.testClient.mine({ blocks: 64 }); // so the transfers are final

  proxy = await startRpcProxy({
    target: anvil.rpcUrl,
    onCall: (method, params) => {
      if (
        method === "eth_getLogs" &&
        (params[0] as { fromBlock?: string } | undefined)?.fromBlock !== undefined
      )
        rangedGetLogs++;
    },
  });
  db = await createTestDatabase();
  project = join(here, ".work", randomUUID());
  await mkdir(dirname(project), { recursive: true });
  await cp(join(here, "fixtures", "token-project"), project, { recursive: true });
  process.env.ANVIL_RPC = proxy.url;
  process.env.TOKEN_ADDRESS = token;
}, 60_000);

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
  await db.drop();
  await proxy.stop();
  await anvil.stop();
});

describe("tidemark", () => {
  it("prints usage and rejects unknown commands", async () => {
    expect((await cli("--help")).code).toBe(0);
    const unknown = await cli("frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.output).toContain("unknown command: frobnicate");
  });

  it("generates registry types that check the project's handlers", async () => {
    const { code } = await cli("codegen");
    expect(code).toBe(0);
    const env = await readFile(join(project, "tidemark-env.d.ts"), "utf8");
    expect(env).toContain('declare module "tidemark:registry"');
    expect(await readFile(join(project, "generated", "schema.graphql"), "utf8")).toContain("type Account");
    // The fixture has a @ts-expect-error on an unknown event: it only passes if the registry is typed.
    const tsc = join(here, "..", "node_modules", ".bin", "tsc");
    await expect(run(tsc, ["--noEmit", "-p", project])).resolves.toBeDefined();
    expect((await cli("codegen")).output).toContain("up to date");
  }, 60_000);

  it("prints a build id that changes with the handlers", async () => {
    const first = (await cli("build")).output.trim();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect((await cli("build")).output.trim()).toBe(first);
  });

  it("develops with hot reload: a change re-indexes from the cache and goes live", async () => {
    expect((await cli("db", "migrate")).code).toBe(0);
    const io = capture();
    const controller = new AbortController();
    const dev = main(["dev", "--root", project, "--database-url", db.url, "--port", "0"], {
      io,
      signal: controller.signal,
    });
    try {
      const url = await waitFor(() => /API on (http:\/\/\S+)/.exec(io.lines.join("\n"))?.[1]);
      const status = async () => (await (await fetch(`${url}/status`)).json()) as { build?: string };
      const balances = async () => {
        const res = await fetch(`${url}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ accounts(orderBy: [{ id: ASC }]) { nodes { id balance } } }" }),
        });
        const body = (await res.json()) as {
          data?: { accounts: { nodes: { id: string; balance: string }[] } };
        };
        return Object.fromEntries((body.data?.accounts.nodes ?? []).map((n) => [n.id, n.balance]));
      };
      const first = await waitFor(async () => (await status()).build);

      // Live queries over WebSocket on the same port.
      const ws = new WebSocket(`${url.replace("http", "ws")}/graphql/ws`, "graphql-transport-ws");
      const acked = new Promise<boolean>((resolve) => {
        ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init" }));
        ws.onmessage = (e) =>
          resolve((JSON.parse(String(e.data)) as { type: string }).type === "connection_ack");
        ws.onerror = () => resolve(false);
      });
      expect(await acked).toBe(true);
      ws.close();
      await waitFor(async () => (await balances())[recipients[2]?.toLowerCase() ?? ""] === "300");

      // Change the handlers: credit double. A new build, from the cache: no ranged eth_getLogs.
      rangedGetLogs = 0;
      const handlers = join(project, "src", "index.ts");
      const source = await readFile(handlers, "utf8");
      await writeFile(handlers, source.replace("value * 1n", "value * 2n"));
      const second = await waitFor(async () => {
        const build = (await status()).build;
        return build !== undefined && build !== first ? build : undefined;
      });
      expect(await balances()).toMatchObject({ [recipients[2]?.toLowerCase() ?? ""]: "600" });
      expect(rangedGetLogs).toBe(0);
      expect(io.lines.join("\n")).toContain(`build ${second}: live`);

      // A save that does not compile leaves the running build serving.
      await writeFile(handlers, `${source}\nthis is not typescript(`);
      await waitFor(() => (io.lines.some((l) => l.includes("keeping the running build")) ? true : undefined));
      expect((await status()).build).toBe(second);
      await writeFile(handlers, source.replace("value * 1n", "value * 2n"));

      const listed = await cli("builds", "list", "--json");
      const { live, builds } = JSON.parse(listed.output) as {
        live: { activeBuild: string; previousBuild: string };
        builds: { buildId: string }[];
      };
      expect(live.activeBuild).toBe(second);
      expect(live.previousBuild).toBe(first);
      expect(builds.map((b) => b.buildId)).toEqual(expect.arrayContaining([first, second]));

      expect((await cli("outbox", "list", "--json")).output).toBe("[]");
      expect((await cli("outbox", "redrive")).output).toContain("nothing to redrive");
      expect((await cli("outbox", "list", "--status", "bogus")).code).toBe(2);

      expect((await cli("rollback")).code).toBe(0);
      await waitFor(async () => ((await status()).build === first ? true : undefined));
    } finally {
      controller.abort();
      expect(await dev).toBe(0);
    }
  }, 90_000);

  it("deploys a new build as a one-off task that exits once it is live", async () => {
    const handlers = join(project, "src", "index.ts");
    const source = await readFile(handlers, "utf8");
    await writeFile(handlers, source.replace(/value \* \dn/, "value * 3n"));
    try {
      const { code, output } = await cli("deploy", "--exit-when-live");
      expect(code).toBe(0);
      const live = /build ([0-9a-f]{16}): live/.exec(output)?.[1];
      const listed = JSON.parse((await cli("builds", "list", "--json")).output) as {
        live: { activeBuild: string };
      };
      expect(listed.live.activeBuild).toBe(live);
    } finally {
      await writeFile(handlers, source);
    }
  }, 60_000);

  it("verifies the sync cache against headers, and exports and imports it", async () => {
    for (const mode of ["bloom", "receipts-root"]) {
      const { code, output } = await cli("verify", "--chain", "anvil", "--mode", mode);
      expect({ mode, code }).toEqual({ mode, code: 0 });
      expect(output).toContain("no differences");
    }
    expect((await cli("verify")).code).toBe(2); // --chain is required
    const dir = join(project, "cache-export");
    const exported = await cli("cache", "export", dir, "--chain", "anvil");
    expect(exported.code).toBe(0);
    expect(exported.output).toContain("exported chains 31337");
    const imported = await cli("cache", "import", dir);
    expect(imported.code).toBe(0);
    expect(imported.output).toContain("imported chains 31337");
  });

  it("reports a project that does not compile", async () => {
    const handlers = join(project, "src", "index.ts");
    const source = await readFile(handlers, "utf8");
    await writeFile(handlers, `${source}\nconst = ;`);
    const { code, output } = await cli("build");
    expect(code).toBe(1);
    expect(output).toMatch(/src\/index\.ts:\d+:\d+/);
    await writeFile(handlers, source);
  });

  it("runs as a binary", async () => {
    const bin = join(here, "..", "dist", "bin.js");
    const { stdout } = await run(process.execPath, [bin, "build", "--root", project]);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{16}$/);
  }, 30_000);
});

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}
