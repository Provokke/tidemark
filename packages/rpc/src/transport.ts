import {
  HttpStatusError,
  InvalidResponseError,
  JsonRpcResponseError,
  ResponseTooLargeError,
  TransportError,
} from "./errors.js";
import type { ReadableStreamReadResult } from "node:stream/web";
import type { JsonRpcRequest } from "./types.js";

export interface HttpTransportOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly endpointId: string;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function toError(response: JsonRpcResponse, endpoint: string): JsonRpcResponseError | undefined {
  if (response.error === undefined) return undefined;
  const code = typeof response.error.code === "number" ? response.error.code : -32603;
  const message = typeof response.error.message === "string" ? response.error.message : "unknown error";
  return new JsonRpcResponseError(code, message, response.error.data, endpoint);
}

/** JSON-RPC over HTTP POST with a timeout and a cap on the response size. */
export class HttpTransport {
  readonly #url: string;
  readonly #options: HttpTransportOptions;
  #nextId = 1;

  constructor(url: string, options: HttpTransportOptions) {
    this.#url = url;
    this.#options = options;
  }

  async request(request: JsonRpcRequest): Promise<unknown> {
    const id = this.#nextId++;
    const body = await this.#post({ jsonrpc: "2.0", id, method: request.method, params: request.params });
    if (Array.isArray(body) || typeof body !== "object" || body === null) {
      throw new InvalidResponseError("response is not a JSON-RPC object", this.#options.endpointId);
    }
    const response = body as JsonRpcResponse;
    const error = toError(response, this.#options.endpointId);
    if (error !== undefined) throw error;
    if (!("result" in response))
      throw new InvalidResponseError("response has no result", this.#options.endpointId);
    return response.result;
  }

  /**
   * Sends requests as one JSON-RPC batch, so one node answers all of them. Each element of the
   * returned array is the result, or the error, for the request at the same position.
   */
  async batch(requests: readonly JsonRpcRequest[]): Promise<unknown[]> {
    const first = this.#nextId;
    this.#nextId += requests.length;
    const payload = requests.map((r, i) => ({
      jsonrpc: "2.0",
      id: first + i,
      method: r.method,
      params: r.params,
    }));
    const body = await this.#post(payload);
    if (!Array.isArray(body)) {
      // Some servers answer a batch with a single error object (for example, batching disabled).
      const error =
        typeof body === "object" && body !== null ? toError(body, this.#options.endpointId) : undefined;
      throw error ?? new InvalidResponseError("batch response is not an array", this.#options.endpointId);
    }
    const byId = new Map<unknown, JsonRpcResponse>();
    for (const item of body as JsonRpcResponse[]) byId.set(item.id, item);
    return payload.map((p) => {
      const item = byId.get(p.id);
      if (item === undefined) {
        throw new InvalidResponseError(`batch response is missing id ${p.id}`, this.#options.endpointId);
      }
      return toError(item, this.#options.endpointId) ?? item.result;
    });
  }

  async #post(payload: unknown): Promise<unknown> {
    const endpoint = this.#options.endpointId;
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      // The cause is dropped on purpose: fetch errors carry the URL.
      throw new TransportError(timeout ? "request timed out" : "connection failed", timeout, endpoint);
    }

    let text: string;
    try {
      text = await this.#readCapped(response);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) throw error;
      throw new TransportError("response body was cut off", false, endpoint);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok)
        throw new HttpStatusError(
          response.status,
          retryAfterMs(response.headers.get("retry-after")),
          endpoint,
        );
      throw new InvalidResponseError("response is not JSON", endpoint);
    }
    // A JSON-RPC error in a non-2xx body is more specific than the status: keep it.
    if (!response.ok) {
      const error =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? toError(body, endpoint)
          : undefined;
      if (error !== undefined && response.status !== 429) throw error;
      throw new HttpStatusError(response.status, retryAfterMs(response.headers.get("retry-after")), endpoint);
    }
    return body;
  }

  async #readCapped(response: Response): Promise<string> {
    const limit = this.#options.maxResponseBytes;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel();
      throw new ResponseTooLargeError(
        `response of ${declared} bytes exceeds ${limit}`,
        this.#options.endpointId,
      );
    }
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ResponseTooLargeError(`response exceeds ${limit} bytes`, this.#options.endpointId);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
