import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PermanentDeliveryError } from "./errors.js";

/** IPv4 ranges a webhook may never reach: private, loopback, link-local (cloud metadata), and the rest. */
const V4_DENY: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

function v4Denied(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_DENY.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    return n >= start && n < start + size;
  });
}

/** The eight 16-bit groups of an IPv6 address (with an embedded IPv4 tail expanded). */
function v6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split("%")[0] ?? "";
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail !== null) {
    const n = v4ToInt(tail[1] as string);
    text = `${text.slice(0, -(tail[1] as string).length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? [] : Array.from({ length: 8 - left.length - right.length }, () => "0");
  return [...left, ...fill, ...right].map((g) => Number.parseInt(g, 16));
}

function v6Denied(ip: string): boolean {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true; // unparseable: refuse
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  const embeddedV4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(8)) return true; // ::
  if (allZeroUpTo(7) && g7 === 1) return true; // ::1
  if (allZeroUpTo(5) && g5 === 0xffff) return v4Denied(embeddedV4); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return v4Denied(embeddedV4); // ::a.b.c.d (deprecated compatible form)
  if (g0 === 0x64 && g1 === 0xff9b) return v4Denied(embeddedV4); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (includes fd00:ec2::254)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0100 && g1 === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (g0 === 0x2002) return v4Denied(`${g1 >> 8}.${g1 & 0xff}.${(g[2] ?? 0) >> 8}.${(g[2] ?? 0) & 0xff}`); // 6to4
  return false;
}

/** Whether an IP address is one a webhook must not reach. */
export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Denied(ip);
  if (family === 6) return v6Denied(ip);
  return true;
}

export interface ResolvedTarget {
  readonly url: URL;
  /** The host name as written, for SNI and the Host header. */
  readonly hostname: string;
  /** The vetted address to connect to: pinned, so DNS cannot change between the check and the connect. */
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Vets a webhook URL: https only, no credentials in it, and every address its host resolves to must
 * be public (a host with one private address is refused, against DNS rebinding). Returns the address
 * to pin. `insecure` (development only) allows http and private addresses.
 */
export async function resolveWebhookTarget(
  rawUrl: string,
  options: {
    insecure?: boolean;
    resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  } = {},
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PermanentDeliveryError("webhook URL is not a URL");
  }
  const insecure = options.insecure === true;
  if (url.protocol !== "https:" && !(insecure && url.protocol === "http:")) {
    throw new PermanentDeliveryError(`webhook URL must use https, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "")
    throw new PermanentDeliveryError("webhook URL must not contain credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  const addresses =
    literal !== 0
      ? [{ address: hostname, family: literal }]
      : await (options.resolve ?? ((h: string) => lookup(h, { all: true, order: "verbatim" })))(
          hostname,
        ).catch((error: unknown) => {
          throw new Error(`cannot resolve ${hostname}: ${(error as Error).message}`, { cause: error });
        });
  if (addresses.length === 0) throw new Error(`cannot resolve ${hostname}`);
  if (!insecure) {
    const bad = addresses.find((a) => isForbiddenAddress(a.address));
    if (bad !== undefined) {
      throw new PermanentDeliveryError(
        `webhook host ${hostname} resolves to a non-public address (${bad.address})`,
      );
    }
  }
  const first = addresses[0] as { address: string; family: number };
  return { url, hostname, address: first.address, family: first.family === 6 ? 6 : 4 };
}
