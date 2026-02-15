/** Base class: every error the pool throws or records is one of these. */
export class RpcError extends Error {
  override name = "RpcError";
  /** The endpoint id (never its URL) the error came from, when it came from one. */
  readonly endpoint: string | undefined;

  constructor(message: string, endpoint?: string, options?: ErrorOptions) {
    super(message, options);
    this.endpoint = endpoint;
  }
}

/** A JSON-RPC error object in the response. */
export class JsonRpcResponseError extends RpcError {
  override name = "JsonRpcResponseError";
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown, endpoint?: string) {
    super(`JSON-RPC error ${code}: ${message}`, endpoint);
    this.code = code;
    this.data = data;
  }
}

/** A non-2xx HTTP status with no JSON-RPC error in the body. */
export class HttpStatusError extends RpcError {
  override name = "HttpStatusError";
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs: number | undefined, endpoint?: string) {
    super(`HTTP ${status}`, endpoint);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Connection refused or reset, DNS failure, or a timeout. */
export class TransportError extends RpcError {
  override name = "TransportError";
  readonly timeout: boolean;

  constructor(message: string, timeout: boolean, endpoint?: string, options?: ErrorOptions) {
    super(message, endpoint, options);
    this.timeout = timeout;
  }
}

/** The response body passed the size limit. For `eth_getLogs` this means the range is too large. */
export class ResponseTooLargeError extends RpcError {
  override name = "ResponseTooLargeError";
}

/** Malformed, or inconsistent with the request: a log outside the range, a mismatched block hash. */
export class InvalidResponseError extends RpcError {
  override name = "InvalidResponseError";
}

/** The node's head is below the block a read needs, so its answer cannot be trusted to be complete. */
export class LaggingNodeError extends RpcError {
  override name = "LaggingNodeError";
  readonly head: number;
  readonly needed: number;

  constructor(head: number, needed: number, endpoint?: string) {
    super(`node head ${head} is below block ${needed}`, endpoint);
    this.head = head;
    this.needed = needed;
  }
}

/** The provider refused an `eth_getLogs` range. `suggestedSize` is a block count it said would work. */
export class RangeTooLargeError extends RpcError {
  override name = "RangeTooLargeError";
  readonly suggestedSize: number | undefined;

  constructor(suggestedSize: number | undefined, endpoint?: string, options?: ErrorOptions) {
    super(
      `range refused${suggestedSize === undefined ? "" : `; provider suggests ${suggestedSize} blocks`}`,
      endpoint,
      options,
    );
    this.suggestedSize = suggestedSize;
  }
}

/** Every endpoint is behind the block a read needs. Not a failure: try again later. */
export class NotYetAvailableError extends RpcError {
  override name = "NotYetAvailableError";
}

/** No endpoint produced an answer. `causes` are already redacted. */
export class AllEndpointsFailedError extends RpcError {
  override name = "AllEndpointsFailedError";
  readonly causes: readonly string[];

  constructor(method: string, causes: readonly string[]) {
    super(`${method}: every endpoint failed: ${causes.join("; ")}`);
    this.causes = causes;
  }
}

/** An endpoint reports a different chain than configured. It is disabled for good. */
export class ChainIdMismatchError extends RpcError {
  override name = "ChainIdMismatchError";
}

/** The request itself is wrong (a revert, invalid params): another endpoint would answer the same. */
export class DeterministicRpcError extends RpcError {
  override name = "DeterministicRpcError";
}

export type ErrorKind = "range" | "rate-limit" | "lag" | "failover" | "fatal";

export interface Classification {
  readonly kind: ErrorKind;
  readonly suggestedSize?: number;
  readonly retryAfterMs?: number;
}

const RANGE_MESSAGE =
  /block range|range limit|range is too|too (?:many|large|wide)|more than \d[\d,]* (?:results|logs)|response size|log response|query timeout|max(?:imum)? (?:block )?range|limited to|exceed(?:s|ed)? (?:the )?(?:max|limit)|returned more than/i;
const RATE_LIMIT_MESSAGE =
  /rate.?limit|too many requests|request limit|compute units|capacity|throughput|quota|daily request count/i;
const BRACKETED_RANGE = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i;
const SIZE_BEFORE_RANGE = /\b(\d[\d,]*)\s*(k)?[\s-]*blocks?\s*range/i;
const SIZE_AFTER_LIMIT =
  /(?:max(?:imum)?\s*(?:block\s*)?range|range\s*limit|limited\s*to(?:\s*a)?|range\s*(?:of|is))\D{0,4}(\d[\d,]*)\s*(k)?/i;

function parseSize(digits: string | undefined, kilo: string | undefined): number | undefined {
  if (digits === undefined) return undefined;
  const n = Number(digits.replaceAll(",", "")) * (kilo === undefined ? 1 : 1_000);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Reads a block count out of a provider's range refusal. Shapes seen in provider documentation:
 *
 * - Alchemy: `... this block range should work: [0x1a, 0x2b]`
 * - Infura: `query returned more than 10000 results. Try with this block range [0x1, 0x2].`, and
 *   `data: { from, to }`
 * - others: `exceed maximum block range: 5000`, `eth_getLogs is limited to a 10000 range`,
 *   `up to a 2K block range`
 *
 * These are taken from documentation, not measured against each provider; an unrecognised shape
 * falls back to halving, which only costs extra calls.
 */
export function suggestedRangeSize(message: string, data?: unknown): number | undefined {
  const bracket = BRACKETED_RANGE.exec(message);
  if (bracket?.[1] !== undefined && bracket[2] !== undefined) {
    const size = Number(BigInt(bracket[2]) - BigInt(bracket[1])) + 1;
    if (Number.isSafeInteger(size) && size >= 1) return size;
  }
  if (typeof data === "object" && data !== null && "from" in data && "to" in data) {
    const { from, to } = data;
    if (typeof from === "string" && typeof to === "string") {
      try {
        const size = Number(BigInt(to) - BigInt(from)) + 1;
        if (Number.isSafeInteger(size) && size >= 1) return size;
      } catch {
        // not hex quantities; fall through
      }
    }
  }
  const before = SIZE_BEFORE_RANGE.exec(message);
  if (before !== null) return parseSize(before[1], before[2]);
  const after = SIZE_AFTER_LIMIT.exec(message);
  if (after !== null) return parseSize(after[1], after[2]);
  return undefined;
}

/** Decides what a failed call means for the pool: shrink the range, back off, fail over or stop. */
export function classify(error: unknown, method: string): Classification {
  // Range refusals apply to the ranged reads: logs and trace_filter.
  const isGetLogs = method === "eth_getLogs" || method === "trace_filter";
  if (error instanceof LaggingNodeError) return { kind: "lag" };
  if (error instanceof DeterministicRpcError || error instanceof ChainIdMismatchError)
    return { kind: "fatal" };
  if (error instanceof ResponseTooLargeError) return { kind: isGetLogs ? "range" : "failover" };
  if (error instanceof HttpStatusError) {
    if (error.status === 429) {
      return error.retryAfterMs === undefined
        ? { kind: "rate-limit" }
        : { kind: "rate-limit", retryAfterMs: error.retryAfterMs };
    }
    if (error.status === 413 && isGetLogs) return { kind: "range" };
    return { kind: "failover" };
  }
  if (error instanceof JsonRpcResponseError) {
    const message = error.message;
    if (isGetLogs && RANGE_MESSAGE.test(message)) {
      const suggested = suggestedRangeSize(message, error.data);
      return suggested === undefined ? { kind: "range" } : { kind: "range", suggestedSize: suggested };
    }
    // 3 is an execution revert: every honest node gives the same answer.
    if (error.code === 3) return { kind: "fatal" };
    if (RATE_LIMIT_MESSAGE.test(message) || error.code === 429) return { kind: "rate-limit" };
    return { kind: "failover" };
  }
  return { kind: "failover" };
}
