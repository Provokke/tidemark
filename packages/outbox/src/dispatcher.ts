import { metrics } from "@tidemark/core";
import type { OutboxConfig, OutboxDelivery, OutboxDestination, OutboxMessage } from "@tidemark/engine";
import { type Sql, advisoryKey, ident, migrate } from "@tidemark/pg";
import { PermanentDeliveryError } from "./errors.js";
import { outboxMigrations } from "./migrations.js";
import { kafkaSender, natsSender } from "./senders/brokers.js";
import { sqsSender } from "./senders/sqs.js";
import type { Sender } from "./senders/types.js";
import { webhookSender } from "./senders/webhook.js";

const deliveries = metrics.counter(
  "tm_outbox_deliveries_total",
  "Outbox delivery attempts, by destination, kind and outcome.",
  ["destination", "kind", "outcome"],
);
const deliverySeconds = metrics.histogram("tm_outbox_delivery_seconds", "Outbox delivery duration.", [
  "destination",
]);
const queued = metrics.gauge("tm_outbox_deliveries", "Outbox deliveries by status.", ["live", "status"]);

export const migrateOutbox = (sql: Sql) => migrate(sql, "outbox", outboxMigrations);

const COMMIT_CHANNEL = "tm_commit";
const CUTOVER_CHANNEL = "tidemark_cutover";

/** Builds the sender for a destination. */
export function senderFor(destination: OutboxDestination): Sender {
  switch (destination.kind) {
    case "webhook":
      return webhookSender(destination);
    case "sqs":
      return sqsSender(destination);
    case "nats":
      return natsSender(destination);
    case "kafka":
      return kafkaSender(destination);
    case "custom":
      return { send: (d) => destination.send(d) };
  }
}

export type DispatchEvent =
  | {
      readonly type: "delivered";
      readonly destination: string;
      readonly id: string;
      readonly kind: "event" | "retraction";
      readonly attempt: number;
    }
  | {
      readonly type: "failed";
      readonly destination: string;
      readonly id: string;
      readonly kind: "event" | "retraction";
      readonly attempt: number;
      readonly error: string;
      readonly dead: boolean;
    };

export interface DispatcherOptions {
  readonly sql: Sql;
  readonly config: OutboxConfig;
  /** The live schema whose active build delivers. Default "live". */
  readonly live?: string;
  /** Override senders by destination name (tests, or a sender you build yourself). */
  readonly senders?: Readonly<Record<string, Sender>>;
  /** Most deliveries sent per cycle. Default 500. */
  readonly batchSize?: number;
  /** Deliveries in flight at once per destination. Default 8. */
  readonly concurrency?: number;
  /** First retry delay; doubles per attempt, with jitter, up to `maxBackoffMs`. Default 1,000. */
  readonly baseBackoffMs?: number;
  /** Default 10 minutes. */
  readonly maxBackoffMs?: number;
  /** Cycle at least this often even without notifications (retries, finality). Default 1,000. */
  readonly pollIntervalMs?: number;
  readonly onEvent?: (event: DispatchEvent) => void;
}

export interface CycleStats {
  readonly discovered: number;
  readonly retractions: number;
  readonly dropped: number;
  readonly delivered: number;
  readonly failed: number;
}

interface DueRow {
  destination: string;
  outbox_id: string;
  kind: "event" | "retraction";
  attempts: number;
  body: OutboxMessage;
}

/**
 * Delivers the outbox of the build a live schema serves. One cycle:
 *
 * 1. queues every outbox row of the active build that is due (`latest` rows at once, `finalized`
 *    rows once their block is final) for each destination its topic routes to;
 * 2. drops queued-but-unsent `latest` rows that a reorg removed;
 * 3. queues a retraction for every delivered `latest` row that a reorg removed;
 * 4. sends what is due, with exponential backoff and jitter; a delivery that fails `maxAttempts`
 *    times, or permanently, is dead until redriven.
 *
 * Steps 2 and 3 act only once the build has indexed past the row's block, so a build that has
 * not caught up (just after a cutover, or mid-reorg) never retracts what it has not reached.
 * Deliveries are keyed by the deterministic outbox id, so a new build's identical rows are never
 * sent twice.
 */
export class OutboxDispatcher {
  readonly #o: DispatcherOptions;
  readonly #live: string;
  readonly #senders = new Map<string, Sender>();

  constructor(options: DispatcherOptions) {
    this.#o = options;
    this.#live = options.live ?? "live";
  }

  #sender(name: string): Sender | undefined {
    let sender = this.#senders.get(name);
    if (sender === undefined) {
      const override = this.#o.senders?.[name];
      const destination = this.#o.config.destinations[name];
      sender = override ?? (destination === undefined ? undefined : senderFor(destination));
      if (sender !== undefined) this.#senders.set(name, sender);
    }
    return sender;
  }

  /** Topics routed to a destination, or "*" for all. */
  #topicsFor(destination: string): "*" | string[] {
    const topics: string[] = [];
    for (const [topic, names] of Object.entries(this.#o.config.routes)) {
      if (!names.includes(destination)) continue;
      if (topic === "*") return "*";
      topics.push(topic);
    }
    return topics;
  }

  async #activeBuild(): Promise<{ buildId: string; schema: string } | undefined> {
    const [row] = await this.#o.sql<{ build_id: string; schema_name: string; has_outbox: boolean }[]>`
      select b.build_id, b.schema_name, to_regclass(quote_ident(b.schema_name) || '._tm_outbox') is not null as has_outbox
      from tm_meta.live_schemas l join tm_meta.builds b on b.build_id = l.active_build
      where l.name = ${this.#live}
    `.catch(() => []);
    return row === undefined || !row.has_outbox
      ? undefined
      : { buildId: row.build_id, schema: row.schema_name };
  }

  /** One dispatch cycle. */
  async cycle(): Promise<CycleStats> {
    const sql = this.#o.sql;
    const active = await this.#activeBuild();
    let discovered = 0;
    let retractions = 0;
    let dropped = 0;
    if (active !== undefined) {
      const s = ident(active.schema);
      for (const destination of Object.keys(this.#o.config.destinations)) {
        const topics = this.#topicsFor(destination);
        if (topics !== "*" && topics.length === 0) continue;
        const inserted = await sql.unsafe(
          `insert into tm_outbox.deliveries
             (live, destination, outbox_id, kind, topic, build_id, chain_id, block_number, checkpoint, delivery_when, body)
           select $1, $2, o.id, 'event', o.topic, $3, o.chain_id, o.block_number, o.checkpoint, o.delivery_when,
             jsonb_build_object(
               'id', o.id, 'type', o.topic, 'specVersion', '1', 'build', $3::text, 'chainId', o.chain_id,
               'block', jsonb_build_object(
                 'number', o.block_number::text, 'hash', '0x' || encode(o.block_hash, 'hex'),
                 'timestamp', o.block_timestamp, 'finalized', o.block_number <= c.finalized_block),
               'checkpoint', o.checkpoint, 'data', o.payload)
           from ${s}."_tm_outbox" o join ${s}."_tm_checkpoints" c on c.chain_id = o.chain_id
           where (o.delivery_when = 'latest' or o.block_number <= c.finalized_block)
             and ($4::boolean or o.topic = any($5::text[]))
           on conflict do nothing`,
          [this.#live, destination, active.buildId, topics === "*", topics === "*" ? [] : topics],
        );
        discovered += inserted.count;
      }
      // Gone before it was sent: nothing to undo.
      const gone = await sql.unsafe(
        `delete from tm_outbox.deliveries d
         using ${s}."_tm_checkpoints" c
         where d.live = $1 and d.kind = 'event' and d.status <> 'delivered' and d.delivery_when = 'latest'
           and c.chain_id = d.chain_id and c.block_number >= d.block_number
           and not exists (select 1 from ${s}."_tm_outbox" o where o.id = d.outbox_id)`,
        [this.#live],
      );
      dropped = gone.count;
      // Gone after it was sent: tell the receiver.
      const retracted = await sql.unsafe(
        `insert into tm_outbox.deliveries
           (live, destination, outbox_id, kind, topic, build_id, chain_id, block_number, checkpoint, delivery_when, body)
         select d.live, d.destination, d.outbox_id, 'retraction', d.topic, d.build_id, d.chain_id, d.block_number,
           d.checkpoint, d.delivery_when, d.body || jsonb_build_object('type', d.topic || '.retracted')
         from tm_outbox.deliveries d join ${s}."_tm_checkpoints" c on c.chain_id = d.chain_id
         where d.live = $1 and d.kind = 'event' and d.status = 'delivered' and d.delivery_when = 'latest'
           and c.block_number >= d.block_number
           and not exists (select 1 from ${s}."_tm_outbox" o where o.id = d.outbox_id)
         on conflict do nothing`,
        [this.#live],
      );
      retractions = retracted.count;
    }

    const due = await sql<DueRow[]>`
      select destination, outbox_id, kind, attempts, body from tm_outbox.deliveries
      where live = ${this.#live} and status = 'pending' and next_attempt_at <= now()
      order by checkpoint, kind, destination
      limit ${this.#o.batchSize ?? 500}
    `;
    const byDestination = new Map<string, DueRow[]>();
    for (const row of due) {
      const list = byDestination.get(row.destination) ?? [];
      list.push(row);
      byDestination.set(row.destination, list);
    }
    let delivered = 0;
    let failed = 0;
    await Promise.all(
      [...byDestination].map(async ([destination, rows]) => {
        const sender = this.#sender(destination);
        if (sender === undefined) return; // destination removed from the config: leave queued
        const queue = [...rows];
        const worker = async () => {
          for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
            if (await this.#deliver(sender, row)) delivered++;
            else failed++;
          }
        };
        await Promise.all(Array.from({ length: Math.min(this.#o.concurrency ?? 8, queue.length) }, worker));
      }),
    );
    return { discovered, retractions, dropped, delivered, failed };
  }

  async #deliver(sender: Sender, row: DueRow): Promise<boolean> {
    const attempt = row.attempts + 1;
    const delivery: OutboxDelivery = {
      destination: row.destination,
      kind: row.kind,
      attempt,
      message: row.body,
    };
    const key = { live: this.#live, destination: row.destination, id: row.outbox_id, kind: row.kind };
    const started = performance.now();
    try {
      await sender.send(delivery);
      deliverySeconds.observe({ destination: row.destination }, (performance.now() - started) / 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = this.#o.config.maxAttempts ?? 12;
      const dead = error instanceof PermanentDeliveryError || attempt >= maxAttempts;
      const ceiling = Math.min(
        this.#o.maxBackoffMs ?? 600_000,
        (this.#o.baseBackoffMs ?? 1_000) * 2 ** (attempt - 1),
      );
      const delayMs = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
      await this.#o.sql`
        update tm_outbox.deliveries set attempts = ${attempt}, last_error = ${message.slice(0, 1000)},
          status = ${dead ? "dead" : "pending"}, next_attempt_at = now() + ${delayMs} * interval '1 millisecond'
        where live = ${key.live} and destination = ${key.destination} and outbox_id = ${key.id} and kind = ${key.kind}
      `;
      deliveries.inc({ destination: row.destination, kind: row.kind, outcome: dead ? "dead" : "failed" });
      this.#o.onEvent?.({
        type: "failed",
        destination: row.destination,
        id: row.outbox_id,
        kind: row.kind,
        attempt,
        error: message,
        dead,
      });
      return false;
    }
    await this.#o.sql`
      update tm_outbox.deliveries set attempts = ${attempt}, status = 'delivered', delivered_at = now(), last_error = null
      where live = ${key.live} and destination = ${key.destination} and outbox_id = ${key.id} and kind = ${key.kind}
    `;
    deliveries.inc({ destination: row.destination, kind: row.kind, outcome: "delivered" });
    this.#o.onEvent?.({
      type: "delivered",
      destination: row.destination,
      id: row.outbox_id,
      kind: row.kind,
      attempt,
    });
    return true;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#senders.values()].map(async (s) => {
        await s.close?.().catch(() => undefined);
      }),
    );
    this.#senders.clear();
  }
}

/**
 * Runs the dispatcher until `signal` aborts: one leader per live schema (others wait on an advisory
 * lock, as hot standbys), a cycle on every commit and cutover notification, and at least every
 * `pollIntervalMs` for retries and finality.
 */
export async function runOutboxDispatcher(
  options: DispatcherOptions & { readonly signal: AbortSignal },
): Promise<void> {
  const { sql, signal } = options;
  const aborted = (): boolean => signal.aborted;
  await migrateOutbox(sql);
  const live = options.live ?? "live";
  const connection = await sql.reserve();
  const key = advisoryKey(`outbox:${live}`);
  try {
    for (;;) {
      if (signal.aborted) return;
      const [row] = await connection<{ ok: boolean }[]>`select pg_try_advisory_lock(${key}) as ok`;
      if (row?.ok === true) break;
      await sleep(1_000, signal);
    }
    const dispatcher = new OutboxDispatcher(options);
    // Queue depth for /metrics, read at scrape time.
    const stopCollecting = metrics.onCollect(async () => {
      const rows = await sql<{ status: string; n: number }[]>`
        select status, count(*)::int as n from tm_outbox.deliveries where live = ${live} and status <> 'delivered' group by status
      `.catch(() => []);
      for (const status of ["pending", "dead"])
        queued.set({ live, status }, rows.find((r) => r.status === status)?.n ?? 0);
    });
    let wake: (() => void) | undefined;
    const poke = () => wake?.();
    const listeners = await Promise.all([
      sql.listen(COMMIT_CHANNEL, poke),
      sql.listen(CUTOVER_CHANNEL, poke),
    ]);
    try {
      while (!aborted()) {
        try {
          await dispatcher.cycle();
        } catch (error) {
          // A cycle failing (a dropped connection, a build schema pruned mid-cycle) is retried.
          options.onEvent?.({
            type: "failed",
            destination: "*",
            id: "*",
            kind: "event",
            attempt: 0,
            error: String(error),
            dead: false,
          });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollIntervalMs ?? 1_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
          signal.addEventListener("abort", wake, { once: true });
        });
        wake = undefined;
      }
    } finally {
      await Promise.all(listeners.map((l) => l.unlisten()));
      stopCollecting();
      await dispatcher.close();
    }
  } finally {
    await connection`select pg_advisory_unlock_all()`.catch(() => undefined);
    connection.release();
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export interface DeliveryRecord {
  readonly destination: string;
  readonly id: string;
  readonly kind: "event" | "retraction";
  readonly topic: string;
  readonly status: "pending" | "delivered" | "dead";
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

/** Deliveries, newest first. */
export async function listDeliveries(
  sql: Sql,
  options: {
    live?: string;
    status?: "pending" | "delivered" | "dead";
    destination?: string;
    limit?: number;
  } = {},
): Promise<DeliveryRecord[]> {
  await migrateOutbox(sql);
  const rows = await sql<
    {
      destination: string;
      outbox_id: string;
      kind: "event" | "retraction";
      topic: string;
      status: "pending" | "delivered" | "dead";
      attempts: number;
      last_error: string | null;
      created_at: Date;
      delivered_at: Date | null;
    }[]
  >`
    select destination, outbox_id, kind, topic, status, attempts, last_error, created_at, delivered_at
    from tm_outbox.deliveries
    where live = ${options.live ?? "live"}
      and (${options.status ?? null}::text is null or status = ${options.status ?? null})
      and (${options.destination ?? null}::text is null or destination = ${options.destination ?? null})
    order by created_at desc, outbox_id limit ${options.limit ?? 100}
  `;
  return rows.map((r) => ({
    destination: r.destination,
    id: r.outbox_id,
    kind: r.kind,
    topic: r.topic,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  }));
}

/** Puts dead deliveries back in the queue (all of them, or the given ids), with fresh attempts. */
export async function redrive(
  sql: Sql,
  options: { live?: string; ids?: readonly string[]; destination?: string } = {},
): Promise<number> {
  await migrateOutbox(sql);
  const ids = options.ids === undefined ? null : [...options.ids];
  const result = await sql`
    update tm_outbox.deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
    where live = ${options.live ?? "live"} and status = 'dead'
      and (${ids}::text[] is null or outbox_id = any(${ids}::text[]))
      and (${options.destination ?? null}::text is null or destination = ${options.destination ?? null})
  `;
  return result.count;
}
