import { describe, expect, it } from "vitest";
import { Registry } from "../src/metrics.js";

describe("metrics registry", () => {
  it("renders counters, gauges and histograms in the Prometheus text format", async () => {
    const r = new Registry();
    const calls = r.counter("tm_rpc_requests_total", "RPC requests.", ["method", "outcome"]);
    calls.inc({ method: "eth_getLogs", outcome: "ok" });
    calls.inc({ method: "eth_getLogs", outcome: "ok" }, 2);
    calls.inc({ method: "eth_call", outcome: 'error "quoted"\nline' });
    const lag = r.gauge("tm_realtime_lag_blocks", "Head minus processed block.", ["chain"]);
    lag.set({ chain: "base" }, 3);
    lag.dec({ chain: "base" });
    const latency = r.histogram("tm_api_request_seconds", "API latency.", ["route"], [0.01, 0.1]);
    latency.observe({ route: "/graphql" }, 0.005);
    latency.observe({ route: "/graphql" }, 0.05);
    latency.observe({ route: "/graphql" }, 3);
    let collected = 0;
    r.onCollect(() => {
      collected++;
      r.gauge("tm_outbox_pending", "Pending deliveries.").set({}, 7);
    });
    const text = await r.render();
    expect(collected).toBe(1);
    expect(text).toBe(
      [
        "# HELP tm_api_request_seconds API latency.",
        "# TYPE tm_api_request_seconds histogram",
        'tm_api_request_seconds_bucket{route="/graphql",le="0.01"} 1',
        'tm_api_request_seconds_bucket{route="/graphql",le="0.1"} 2',
        'tm_api_request_seconds_bucket{route="/graphql",le="+Inf"} 3',
        'tm_api_request_seconds_sum{route="/graphql"} 3.055',
        'tm_api_request_seconds_count{route="/graphql"} 3',
        "# HELP tm_outbox_pending Pending deliveries.",
        "# TYPE tm_outbox_pending gauge",
        "tm_outbox_pending 7",
        "# HELP tm_realtime_lag_blocks Head minus processed block.",
        "# TYPE tm_realtime_lag_blocks gauge",
        'tm_realtime_lag_blocks{chain="base"} 2',
        "# HELP tm_rpc_requests_total RPC requests.",
        "# TYPE tm_rpc_requests_total counter",
        'tm_rpc_requests_total{method="eth_getLogs",outcome="ok"} 3',
        'tm_rpc_requests_total{method="eth_call",outcome="error \\"quoted\\"\\nline"} 1',
        "",
      ].join("\n"),
    );
  });

  it("refuses misuse", () => {
    const r = new Registry();
    const c = r.counter("tm_x_total", "x", ["a"]);
    expect(() => c.inc({ b: "1" })).toThrow(/unknown label/);
    expect(() => c.inc({}, -1)).toThrow(/only go up/);
    expect(() => r.gauge("tm_x_total", "x")).toThrow(/exists as a counter/);
    expect(r.counter("tm_x_total", "x", ["a"])).toBe(c);
    expect(() => r.counter("bad name", "x")).toThrow(/bad metric name/);
  });
});
