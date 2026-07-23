import { type ChildProcess, spawn } from "node:child_process";
import {
  type Chain,
  type PublicClient,
  type TestClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

/** Anvil's default mnemonic. Its keys are public: never use these accounts off a local chain. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export interface AnvilOptions {
  chainId?: number;
  /** Seconds between blocks. Omit for automine: one block per transaction. */
  blockTime?: number;
  /** Override the binary; defaults to `anvil` on the PATH. */
  binary?: string;
}

export interface Anvil {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, ReturnType<typeof mnemonicToAccount>>;
  readonly testClient: TestClient<"anvil", Transport, Chain>;
  /**
   * Replace the newest `depth` blocks with the same number of empty blocks, so every block hash
   * from `head - depth + 1` up changes. Transactions in the replaced blocks are dropped.
   */
  reorg(depth: number): Promise<void>;
  stop(): Promise<void>;
}

async function waitForRpc(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`anvil did not answer at ${url} within ${timeoutMs} ms`, { cause: lastError });
}

export async function startAnvil(options: AnvilOptions = {}): Promise<Anvil> {
  const chainId = options.chainId ?? 31337;
  // Anvil picks its own port and says which. Choosing a free port first and handing it over races
  // with other processes doing the same, and two tests can end up on one chain.
  const args = ["--host", "127.0.0.1", "--port", "0", "--chain-id", String(chainId)];
  if (options.blockTime !== undefined) args.push("--block-time", String(options.blockTime));

  const child = spawn(options.binary ?? "anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const listening = new Promise<number>((resolve, reject) => {
    let stdout = "";
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match !== null) {
        resolve(Number(match[1]));
        stdout = "";
      }
    };
    child.stdout.on("data", onData); // keeps draining after the match, so anvil never blocks on stdout
    child.once("error", (error) => {
      reject(new Error("could not start anvil; is Foundry installed and on the PATH?", { cause: error }));
    });
    child.once("exit", (code) => {
      reject(new Error(`anvil exited early with code ${String(code)}`));
    });
    setTimeout(() => {
      reject(new Error("anvil did not report its port within 15 s"));
    }, 15_000).unref();
  });

  let rpcUrl: string;
  try {
    const port = await listening;
    rpcUrl = `http://127.0.0.1:${port}`;
    await waitForRpc(rpcUrl, child, 15_000);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`anvil failed to start: ${stderr.trim()}`, { cause: error });
  }

  const chain = defineChain({
    id: chainId,
    name: `anvil-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { retryCount: 0 });
  const account = mnemonicToAccount(ANVIL_MNEMONIC);

  const testClient = createTestClient({ chain, mode: "anvil", transport });

  return {
    rpcUrl,
    chain,
    // No caching of eth_blockNumber: a test that just mined a block must see it.
    publicClient: createPublicClient({ chain, transport, pollingInterval: 50, cacheTime: 0 }),
    walletClient: createWalletClient({ chain, transport, account }),
    testClient,
    async reorg(depth: number) {
      // anvil_reorg(depth, txBlockPairs): rebuilds the newest `depth` blocks with the given
      // transactions; none here, so the replacement blocks are empty and every hash changes.
      await testClient.request({
        method: "anvil_reorg" as never,
        params: [depth, []] as never,
      });
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
