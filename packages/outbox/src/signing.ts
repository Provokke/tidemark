import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `Tidemark-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]`: one HMAC-SHA256 of `"<t>.<raw body>"`
 * per secret, so a receiver can rotate secrets without a gap.
 */
export function signatureHeader(rawBody: string, secrets: readonly string[], timestamp: number): string {
  const t = Math.floor(timestamp);
  const parts = secrets.map(
    (secret) => `v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`,
  );
  return [`t=${t}`, ...parts].join(",");
}

export interface VerifyOptions {
  /** Reject signatures older (or newer) than this. Default 300 seconds. */
  readonly toleranceSeconds?: number;
  /** Unix seconds; default now. */
  readonly now?: number;
}

/**
 * For receivers: checks a `Tidemark-Signature` header against the raw request body (the exact bytes,
 * before any JSON parsing) and any of your secrets. Returns false for a bad, missing or stale one.
 */
export function verifySignature(
  rawBody: string,
  header: string | null | undefined,
  secrets: readonly string[],
  options: VerifyOptions = {},
): boolean {
  if (header === null || header === undefined) return false;
  let t: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value !== undefined && /^\d+$/.test(value)) t = Number(value);
    else if (key === "v1" && value !== undefined && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (t === undefined || signatures.length === 0) return false;
  const now = options.now ?? Date.now() / 1000;
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return false;
  for (const secret of secrets) {
    const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
    for (const signature of signatures) {
      const given = Buffer.from(signature);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
  }
  return false;
}
