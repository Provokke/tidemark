import type { ErrorKind } from "./errors.js";

/**
 * Per-endpoint health. Endpoints are tried in configured order, demoted while they fail: an
 * endpoint with an open circuit breaker goes to the back, and a recent error rate pushes it behind
 * healthier ones. Order is otherwise stable, so the operator's preferred (usually cheapest)
 * provider takes the traffic while it works.
 */
export class EndpointHealth {
  latencyEwmaMs = 0;
  /** Exponentially weighted share of recent calls that failed, 0 to 1. */
  errorRate = 0;
  consecutiveFailures = 0;
  openUntil = 0;
  /** The highest head this node has reported. */
  lastHead: number | undefined;
  calls = 0;
  failures = 0;
  lags = 0;
  rateLimits = 0;

  static readonly ALPHA = 0.2;
  static readonly BREAKER_THRESHOLD = 3;
  static readonly BREAKER_MAX_MS = 30_000;

  success(latencyMs: number): void {
    this.calls++;
    this.latencyEwmaMs =
      this.latencyEwmaMs === 0
        ? latencyMs
        : this.latencyEwmaMs + EndpointHealth.ALPHA * (latencyMs - this.latencyEwmaMs);
    this.errorRate *= 1 - EndpointHealth.ALPHA;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  failure(kind: ErrorKind, now: number, retryAfterMs?: number): void {
    this.calls++;
    if (kind === "lag") {
      // Lagging is normal for a moment after a block; it does not count against the breaker.
      this.lags++;
      return;
    }
    this.failures++;
    if (kind === "rate-limit") this.rateLimits++;
    this.errorRate += EndpointHealth.ALPHA * (1 - this.errorRate);
    this.consecutiveFailures++;
    if (retryAfterMs !== undefined) {
      this.openUntil = Math.max(this.openUntil, now + Math.min(retryAfterMs, 60_000));
    } else if (this.consecutiveFailures >= EndpointHealth.BREAKER_THRESHOLD) {
      const backoff = 1_000 * 2 ** (this.consecutiveFailures - EndpointHealth.BREAKER_THRESHOLD);
      this.openUntil = now + Math.min(backoff, EndpointHealth.BREAKER_MAX_MS);
    }
  }

  observeHead(head: number): void {
    if (this.lastHead === undefined || head > this.lastHead) this.lastHead = head;
  }

  isOpen(now: number): boolean {
    return now < this.openUntil;
  }

  /** Lower sorts first. Error rate is bucketed so tiny differences do not reorder endpoints. */
  rank(now: number): number {
    return (this.isOpen(now) ? 100 : 0) + Math.round(this.errorRate * 10);
  }
}

/** A token bucket. `take()` resolves when a request may be sent. */
export class TokenBucket {
  readonly #rate: number;
  readonly #burst: number;
  #tokens: number;
  #last: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(perSecond: number, burst: number, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.#rate = perSecond;
    this.#burst = burst;
    this.#tokens = burst;
    this.#now = now;
    this.#last = now();
    this.#sleep = sleep;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = this.#now();
      this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) / 1_000) * this.#rate);
      this.#last = now;
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await this.#sleep(Math.ceil(((1 - this.#tokens) / this.#rate) * 1_000));
    }
  }
}
