import { createHash } from "node:crypto";
import type { Sql } from "@tidemark/pg";
import type { ValidationRule } from "graphql";
import {
  type GraphQLInput,
  type Outcome,
  type Prepared,
  type SqlInput,
  type Target,
  isOutcome,
  prepareGraphQL,
  prepareSql,
} from "./execute.js";
import type { ApiLimits } from "./server.js";

/** What a live query is: a GraphQL query, or a SQL `SELECT`. */
export type LiveSpec = { readonly graphql: GraphQLInput } | { readonly sql: SqlInput };

export interface LiveResult extends Outcome {
  /** Changes whenever the result does: a client's cursor. */
  readonly cursor: string;
  readonly build: string | null;
}

export class LiveLimitError extends Error {
  override name = "LiveLimitError";
}

const COMMIT_CHANNEL = "tm_commit";

/** Read through a call: `closed` changes across awaits, which narrowing does not see. */
const isClosed = (sub: { closed: boolean }): boolean => sub.closed;
const isDirty = (sub: { dirty: boolean }): boolean => sub.dirty;

interface Subscription {
  readonly spec: LiveSpec;
  readonly onResult: (result: LiveResult) => void;
  prepared: Prepared | undefined;
  /** The target `prepared` was made for; a cutover makes it stale. */
  target: Target | undefined;
  cursor: string | undefined;
  running: boolean;
  dirty: boolean;
  closed: boolean;
}

/**
 * Live queries. The indexer notifies `tm_commit` in every commit (and rollback) with the tables it
 * changed; a subscription re-runs only when one of the tables its query reads changed (or on a
 * cutover), and pushes only when the result's hash changed. Re-runs of one subscription never
 * overlap: a notice that arrives during a run causes one more run after it.
 */
export class LiveQueries {
  readonly #sql: Sql;
  readonly #current: () => Target | undefined;
  readonly #limits: ApiLimits;
  readonly #rules: readonly ValidationRule[];
  readonly #max: number;
  readonly #subs = new Set<Subscription>();
  #listener: { unlisten(): Promise<void> } | undefined;
  #lastTarget: Target | undefined;
  #evaluations = 0;

  constructor(options: {
    sql: Sql;
    current: () => Target | undefined;
    limits: ApiLimits;
    rules: readonly ValidationRule[];
    maxSubscriptions?: number;
  }) {
    this.#sql = options.sql;
    this.#current = options.current;
    this.#limits = options.limits;
    this.#rules = options.rules;
    this.#max = options.maxSubscriptions ?? 1_000;
  }

  get size(): number {
    return this.#subs.size;
  }

  /** Query runs so far, first runs included: a metric, and how tests see that re-runs are selective. */
  get evaluations(): number {
    return this.#evaluations;
  }

  async #ensureListening(): Promise<void> {
    if (this.#listener !== undefined) return;
    this.#listener = await this.#sql.listen(COMMIT_CHANNEL, (payload) => {
      let notice: { schema?: string; tables?: string[] };
      try {
        notice = JSON.parse(payload) as typeof notice;
      } catch {
        return;
      }
      this.#onCommit(notice.schema, new Set(notice.tables ?? []));
    });
  }

  #onCommit(schema: string | undefined, tables: ReadonlySet<string>): void {
    const target = this.#current();
    const cutover = target !== this.#lastTarget;
    this.#lastTarget = target;
    for (const sub of this.#subs) {
      if (cutover || sub.target !== target) {
        void this.#refresh(sub);
        continue;
      }
      if (target === undefined || schema !== target.schemaName) continue;
      const reads = sub.prepared?.tables;
      if (reads === "all" || reads === undefined || [...tables].some((t) => reads.has(t)))
        void this.#refresh(sub);
    }
  }

  /** Re-checks every subscription against the current target (call after a cutover). */
  targetChanged(): void {
    this.#onCommit(undefined, new Set());
  }

  async #prepare(sub: Subscription, target: Target): Promise<Prepared | Outcome> {
    return "graphql" in sub.spec
      ? prepareGraphQL(this.#sql, target, this.#limits, this.#rules, sub.spec.graphql)
      : prepareSql(this.#sql, target, this.#limits, sub.spec.sql);
  }

  async #evaluate(sub: Subscription): Promise<LiveResult> {
    this.#evaluations++;
    const target = this.#current();
    let outcome: Outcome;
    if (target === undefined) {
      sub.prepared = undefined;
      sub.target = undefined;
      outcome = { status: 503, body: { error: "no active build" } };
    } else {
      if (sub.target !== target || sub.prepared === undefined) {
        const prepared = await this.#prepare(sub, target);
        sub.target = target;
        sub.prepared = isOutcome(prepared) ? undefined : prepared;
        outcome = isOutcome(prepared) ? prepared : await prepared.run();
      } else {
        outcome = await sub.prepared.run();
      }
    }
    const cursor = createHash("sha256")
      .update(JSON.stringify([outcome.status, outcome.body]))
      .digest("hex")
      .slice(0, 32);
    return { ...outcome, cursor, build: target?.buildId ?? null };
  }

  async #refresh(sub: Subscription): Promise<void> {
    if (sub.closed) return;
    if (sub.running) {
      sub.dirty = true;
      return;
    }
    sub.running = true;
    try {
      do {
        sub.dirty = false;
        const result = await this.#evaluate(sub).catch((error: unknown): LiveResult => ({
          status: 500,
          body: { error: error instanceof Error ? error.message : String(error) },
          cursor: "error",
          build: null,
        }));
        if (isClosed(sub)) return;
        if (result.cursor !== sub.cursor) {
          sub.cursor = result.cursor;
          sub.onResult(result);
        }
      } while (isDirty(sub) && !isClosed(sub));
    } finally {
      sub.running = false;
    }
  }

  /**
   * Subscribes: `onResult` gets the first result at once (also returned), then every changed
   * result until `unsubscribe`. An invalid query still subscribes, with its error as the result,
   * since a cutover can make it valid.
   */
  async subscribe(
    spec: LiveSpec,
    onResult: (result: LiveResult) => void,
  ): Promise<{ first: LiveResult; unsubscribe: () => void }> {
    if (this.#subs.size >= this.#max) throw new LiveLimitError(`at most ${this.#max} live queries at once`);
    await this.#ensureListening();
    this.#lastTarget ??= this.#current();
    const sub: Subscription = {
      spec,
      onResult,
      prepared: undefined,
      target: undefined,
      cursor: undefined,
      running: true,
      dirty: false,
      closed: false,
    };
    this.#subs.add(sub);
    let first: LiveResult;
    try {
      first = await this.#evaluate(sub);
    } finally {
      sub.running = false;
    }
    sub.cursor = first.cursor;
    onResult(first);
    if (sub.dirty) void this.#refresh(sub);
    return {
      first,
      unsubscribe: () => {
        sub.closed = true;
        this.#subs.delete(sub);
      },
    };
  }

  /** Waits until the result differs from `cursor` (at once if it already does), or `timeoutMs`. */
  async poll(
    spec: LiveSpec,
    cursor: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<LiveResult & { changed: boolean }> {
    let resolveChange: (r: LiveResult) => void = () => undefined;
    const changed = new Promise<LiveResult>((r) => (resolveChange = r));
    const { first, unsubscribe } = await this.subscribe(spec, (r) => {
      if (r.cursor !== cursor) resolveChange(r);
    });
    try {
      if (first.cursor !== cursor) return { ...first, changed: true };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((r) => {
        timer = setTimeout(() => {
          r(undefined);
        }, timeoutMs);
        signal?.addEventListener(
          "abort",
          () => {
            r(undefined);
          },
          { once: true },
        );
      });
      const result = await Promise.race([changed, timeout]);
      clearTimeout(timer);
      return result === undefined ? { ...first, changed: false } : { ...result, changed: true };
    } finally {
      unsubscribe();
    }
  }

  async close(): Promise<void> {
    for (const sub of this.#subs) sub.closed = true;
    this.#subs.clear();
    const l = this.#listener;
    this.#listener = undefined;
    await l?.unlisten();
  }
}
