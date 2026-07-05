import type { Abi } from "viem";

export interface AbiSources {
  /** Sourcify server. Default https://sourcify.dev/server. */
  readonly sourcifyUrl?: string;
  /** Etherscan v2 API (one key covers every chain it supports). Default https://api.etherscan.io. */
  readonly etherscanUrl?: string;
  /** Used only when Sourcify has no verified source. */
  readonly etherscanApiKey?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface FetchedAbi {
  readonly abi: Abi;
  readonly source: "sourcify" | "etherscan";
  /** The contract's name, when the source knows it. */
  readonly name?: string;
}

export class AbiNotFoundError extends Error {
  override name = "AbiNotFoundError";
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isAbi(value: unknown): value is Abi {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && "type" in item)
  );
}

/**
 * Fetches a verified contract's ABI: from Sourcify (no key needed), then from Etherscan's v2 API
 * if a key is given. Only the ABI is used; nothing from the response is executed.
 */
export async function fetchAbi(
  chainId: number,
  address: string,
  sources: AbiSources = {},
): Promise<FetchedAbi> {
  if (!ADDRESS.test(address)) throw new Error(`"${address}" is not an address`);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`"${chainId}" is not a chain id`);
  const get = sources.fetch ?? fetch;
  const timeout = sources.timeoutMs ?? 15_000;
  const tried: string[] = [];

  const sourcify = `${sources.sourcifyUrl ?? "https://sourcify.dev/server"}/v2/contract/${chainId}/${address}?fields=abi,compilation`;
  try {
    const res = await get(sourcify, {
      signal: AbortSignal.timeout(timeout),
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { abi?: unknown; compilation?: { name?: unknown } };
      if (isAbi(body.abi)) {
        const name = typeof body.compilation?.name === "string" ? body.compilation.name : undefined;
        return { abi: body.abi, source: "sourcify", ...(name === undefined ? {} : { name }) };
      }
      tried.push("Sourcify: response had no ABI");
    } else tried.push(`Sourcify: HTTP ${res.status}`);
  } catch (error) {
    tried.push(`Sourcify: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (sources.etherscanApiKey !== undefined && sources.etherscanApiKey !== "") {
    const url = new URL("/v2/api", sources.etherscanUrl ?? "https://api.etherscan.io");
    url.search = new URLSearchParams({
      chainid: String(chainId),
      module: "contract",
      action: "getabi",
      address,
      apikey: sources.etherscanApiKey,
    }).toString();
    try {
      const res = await get(url, { signal: AbortSignal.timeout(timeout) });
      const body = (await res.json()) as { status?: unknown; result?: unknown };
      if (body.status === "1" && typeof body.result === "string") {
        const abi: unknown = JSON.parse(body.result);
        if (isAbi(abi)) return { abi, source: "etherscan" };
      }
      tried.push(
        `Etherscan: ${typeof body.result === "string" ? body.result.slice(0, 120) : `HTTP ${res.status}`}`,
      );
    } catch (error) {
      tried.push(`Etherscan: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else tried.push("Etherscan: skipped (no --etherscan-key or ETHERSCAN_API_KEY)");

  throw new AbiNotFoundError(`no verified ABI for ${address} on chain ${chainId}:\n  ${tried.join("\n  ")}`);
}
