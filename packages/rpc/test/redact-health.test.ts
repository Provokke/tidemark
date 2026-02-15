import { describe, expect, it } from "vitest";
import { EndpointHealth, TokenBucket } from "../src/health.js";
import { Redactor } from "../src/redact.js";

describe("Redactor", () => {
  const redactor = new Redactor();
  const urls = [
    "https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWx",
    "https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef",
    "https://withered-cool-sea.quiknode.pro/f00dfeedf00dfeedf00dfeed/",
    "https://rpc.example.com/?apikey=topsecretvalue123",
    "https://user:hunter2hunter2@rpc.example.org/",
  ];
  urls.forEach((url) => {
    redactor.register(url);
  });

  it("removes keys from URLs and from bare echoes", () => {
    const text = [
      `fetch failed for ${urls[0]}`,
      `invalid project id 0123456789abcdef0123456789abcdef`,
      `token f00dfeedf00dfeedf00dfeed not allowed`,
      `GET ${urls[3]} 401`,
      `auth hunter2hunter2 failed`,
      `unregistered https://other.example.net/v1/zzzzzzzzzzzzzzzz?key=abc`,
    ].join("\n");
    const out = redactor.redact(text);
    for (const secret of [
      "AbCdEfGhIjKlMnOpQrStUvWx",
      "0123456789abcdef0123456789abcdef",
      "f00dfeedf00dfeedf00dfeed",
      "topsecretvalue123",
      "hunter2hunter2",
      "zzzzzzzzzzzzzzzz",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("https://eth-mainnet.g.alchemy.com/<redacted>");
  });

  it("ignores empty and tiny strings, which would mangle every message", () => {
    const r = new Redactor();
    r.register(""); // an unset environment variable
    r.register("x");
    r.register("http://a:b@localhost:8545");
    expect(r.redact("TransportError: connection failed")).toBe("TransportError: connection failed");
  });
});

describe("EndpointHealth", () => {
  it("opens the breaker after three consecutive failures and backs off exponentially", () => {
    const h = new EndpointHealth();
    h.failure("failover", 0);
    h.failure("failover", 0);
    expect(h.isOpen(0)).toBe(false);
    h.failure("failover", 0);
    expect(h.isOpen(999)).toBe(true);
    expect(h.isOpen(1_000)).toBe(false);
    h.failure("failover", 1_000);
    expect(h.isOpen(2_999)).toBe(true);
    h.success(10);
    expect(h.isOpen(1_001)).toBe(false);
    expect(h.consecutiveFailures).toBe(0);
  });

  it("does not count lag against the breaker and honours Retry-After", () => {
    const h = new EndpointHealth();
    for (let i = 0; i < 10; i++) h.failure("lag", 0);
    expect(h.isOpen(0)).toBe(false);
    expect(h.lags).toBe(10);
    h.failure("rate-limit", 0, 5_000);
    expect(h.isOpen(4_999)).toBe(true);
    expect(h.isOpen(5_000)).toBe(false);
  });

  it("ranks open and erroring endpoints behind healthy ones", () => {
    const healthy = new EndpointHealth();
    const flaky = new EndpointHealth();
    for (let i = 0; i < 3; i++) flaky.failure("failover", 0);
    expect(flaky.rank(0)).toBeGreaterThan(healthy.rank(0));
  });
});

describe("TokenBucket", () => {
  it("spaces requests at the configured rate after the burst", async () => {
    let now = 0;
    const slept: number[] = [];
    const bucket = new TokenBucket(
      10,
      2,
      () => now,
      (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    );
    for (let i = 0; i < 5; i++) await bucket.take();
    // Two from the burst, then one every 100 ms.
    expect(now).toBeGreaterThanOrEqual(300);
    expect(now).toBeLessThan(400);
  });
});
