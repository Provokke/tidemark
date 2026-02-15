import { describe, expect, it } from "vitest";
import {
  HttpStatusError,
  JsonRpcResponseError,
  LaggingNodeError,
  ResponseTooLargeError,
  TransportError,
  classify,
  suggestedRangeSize,
} from "../src/errors.js";

const rpcError = (code: number, message: string, data?: unknown) =>
  new JsonRpcResponseError(code, message, data);

describe("suggestedRangeSize", () => {
  it.each([
    [
      "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters, this block range should work: [0x10, 0x4f]",
      undefined,
      64,
    ],
    ["query returned more than 10000 results. Try with this block range [0x0, 0x3e7].", undefined, 1000],
    ["query returned more than 10000 results", { from: "0x64", to: "0xc7" }, 100],
    ["exceed maximum block range: 5000", undefined, 5000],
    ["eth_getLogs is limited to a 10,000 range", undefined, 10_000],
    ["You can make eth_getLogs requests with up to a 2K block range", undefined, 2000],
    ["block range is too wide", undefined, undefined],
  ])("%s", (message, data, expected) => {
    expect(suggestedRangeSize(message, data)).toBe(expected);
  });
});

describe("classify", () => {
  it("treats provider range refusals on eth_getLogs as range errors", () => {
    for (const message of [
      "block range is too wide",
      "query returned more than 10000 results",
      "exceed maximum block range: 5000",
      "Log response size exceeded.",
      "query timeout exceeded",
      "eth_getLogs is limited to a 10000 range",
    ]) {
      expect(classify(rpcError(-32005, message), "eth_getLogs").kind).toBe("range");
      // The same message on another method is not a range problem.
      expect(classify(rpcError(-32005, message), "eth_call").kind).not.toBe("range");
    }
    expect(classify(new ResponseTooLargeError("big"), "eth_getLogs").kind).toBe("range");
    expect(classify(new HttpStatusError(413, undefined), "eth_getLogs").kind).toBe("range");
  });

  it("recognises rate limits and keeps Retry-After", () => {
    expect(classify(new HttpStatusError(429, 2000), "eth_call")).toEqual({
      kind: "rate-limit",
      retryAfterMs: 2000,
    });
    expect(
      classify(rpcError(-32005, "daily request count exceeded, request rate limited"), "eth_call").kind,
    ).toBe("rate-limit");
    expect(
      classify(rpcError(429, "Your app has exceeded its compute units per second capacity"), "eth_getLogs")
        .kind,
    ).toBe("rate-limit");
  });

  it("fails over on transport problems, server errors and unknown JSON-RPC errors", () => {
    expect(classify(new TransportError("reset", false), "eth_getLogs").kind).toBe("failover");
    expect(classify(new HttpStatusError(503, undefined), "eth_getLogs").kind).toBe("failover");
    expect(classify(rpcError(-32603, "internal error"), "eth_getLogs").kind).toBe("failover");
    expect(
      classify(rpcError(-32601, "the method eth_getBlockReceipts does not exist"), "eth_getBlockReceipts")
        .kind,
    ).toBe("failover");
  });

  it("stops on reverts and separates lagging nodes", () => {
    expect(classify(rpcError(3, "execution reverted: exceeded the limit"), "eth_call").kind).toBe("fatal");
    expect(classify(new LaggingNodeError(5, 10), "eth_getLogs").kind).toBe("lag");
  });
});
