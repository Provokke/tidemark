import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Abi } from "viem";
import { type AbiSources, fetchAbi } from "./abi.js";
import { type ProjectFile, erc20Template, generateProject } from "./generate.js";

const USAGE = `Usage: create-tidemark <directory> [options]

Start from a template:
  --template erc20         Balances, transfers and allowances of one ERC-20 token (default)

Or from a verified contract (indexes every event it emits, one table per event):
  --address <0x...>        The contract
  --chain-id <n>           Its chain (default 1)
  --contract-name <Name>   Name in the config (default: the verified name, or Contract)
  --start-block <n>        First block to index (default 0; set it to the deployment block)
  --etherscan-key <key>    Fall back to Etherscan v2 when Sourcify has no source ($ETHERSCAN_API_KEY)
  --abi <file.json>        Use a local ABI file instead of fetching one

Other options:
  --chain-name <name>      Chain name in the config (default: mainnet for 1, else chain<id>)
  --force                  Write into a directory that is not empty
`;

const CHAIN_NAMES: Record<number, string> = {
  1: "mainnet",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  11155111: "sepolia",
  84532: "baseSepolia",
  31337: "anvil",
};

export interface CreateOptions {
  readonly sources?: AbiSources;
  readonly log?: (line: string) => void;
}

function ownVersion(): string {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
  return `^${version}`;
}

/** Runs create-tidemark. Resolves with the exit code. */
export async function create(argv: readonly string[], options: CreateOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        template: { type: "string" },
        address: { type: "string" },
        "chain-id": { type: "string" },
        "chain-name": { type: "string" },
        "contract-name": { type: "string" },
        "start-block": { type: "string" },
        "etherscan-key": { type: "string" },
        abi: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    log(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    log(USAGE);
    return 0;
  }
  const dir = positionals[0];
  if (dir === undefined) {
    log(USAGE);
    return 2;
  }
  const root = resolve(dir);
  if (existsSync(root) && (await readdir(root)).length > 0 && values.force !== true) {
    log(`${dir} is not empty; pass --force to write into it anyway`);
    return 1;
  }
  const name = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-_.]/g, "-");
  const chainId = Number(values["chain-id"] ?? 1);
  const chainName = values["chain-name"] ?? CHAIN_NAMES[chainId] ?? `chain${chainId}`;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(chainName)) {
    log(`chain name "${chainName}" must be an identifier`);
    return 2;
  }
  const chain = {
    name: chainName,
    id: chainId,
    rpcEnv: `${chainName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_RPC_URL`,
  };
  const startBlock = Number(values["start-block"] ?? 0);
  const tidemarkVersion = ownVersion();

  let files: ProjectFile[];
  if (values.address === undefined && values.abi === undefined) {
    const template = values.template ?? "erc20";
    if (template !== "erc20") {
      log(`unknown template "${template}"; available: erc20`);
      return 2;
    }
    files = erc20Template({
      name,
      chain,
      tidemarkVersion,
      address: "0x0000000000000000000000000000000000000000",
      startBlock,
    });
    log(`set TOKEN_ADDRESS (or edit tidemark.config.ts) to the token you want to index`);
  } else {
    let abi: Abi;
    let verifiedName: string | undefined;
    if (values.abi !== undefined) {
      abi = JSON.parse(readFileSync(values.abi, "utf8")) as Abi;
    } else {
      try {
        const etherscanApiKey = values["etherscan-key"] ?? process.env.ETHERSCAN_API_KEY;
        const fetched = await fetchAbi(chainId, values.address as string, {
          ...options.sources,
          ...(etherscanApiKey === undefined ? {} : { etherscanApiKey }),
        });
        abi = fetched.abi;
        verifiedName = fetched.name;
        log(
          `fetched the ABI from ${fetched.source}${verifiedName === undefined ? "" : ` (${verifiedName})`}`,
        );
      } catch (error) {
        log(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }
    const contractName = (values["contract-name"] ?? verifiedName ?? "Contract").replace(
      /[^A-Za-z0-9_]/g,
      "",
    );
    const address = (values.address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
    const generated = generateProject({
      name,
      chain,
      tidemarkVersion,
      contracts: [
        {
          name: /^[A-Za-z]/.test(contractName) ? contractName : `C${contractName}`,
          abi,
          address,
          startBlock,
        },
      ],
    });
    files = generated.files;
    for (const s of generated.skipped) log(`skipped ${s}`);
  }

  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  log(
    `created ${dir}:\n\n  cd ${dir}\n  cp .env.example .env.local   # set ${chain.rpcEnv} and DATABASE_URL\n  pnpm install\n  pnpm dev\n`,
  );
  return 0;
}
