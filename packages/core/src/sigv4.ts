import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 for one request. Returns the headers to send: the ones given, plus
 * `x-amz-date`, `x-amz-security-token` (with a session token) and `authorization`.
 */
export function signV4(input: {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** The exact bytes sent (a string is sent as UTF-8). */
  readonly body: string | Uint8Array;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly date?: Date;
}): Record<string, string> {
  const date = input.date ?? new Date();
  const amzDate = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: input.url.host, "x-amz-date": amzDate };
  if (input.credentials.sessionToken !== undefined)
    headers["x-amz-security-token"] = input.credentials.sessionToken;

  const lower = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = lower.map(([k]) => k).join(";");
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join("");
  const path =
    input.url.pathname
      .split("/")
      .map((segment) => encode(decodeURIComponent(segment)))
      .join("/") || "/";
  const query = [...input.url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    sha256(input.body),
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
