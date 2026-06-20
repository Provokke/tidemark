import type { Migration } from "@tidemark/pg";

export const outboxMigrations: readonly Migration[] = [
  {
    id: "0001_deliveries",
    sql: `
      create schema if not exists tm_outbox;
      -- One row per message per destination. Keyed by the live schema (only the build it serves
      -- delivers) and the deterministic outbox id, so a redeploy that regenerates the same ids
      -- sends nothing twice.
      create table tm_outbox.deliveries (
        live text not null,
        destination text not null,
        outbox_id text not null,
        kind text not null check (kind in ('event', 'retraction')),
        topic text not null,
        build_id text not null,
        chain_id bigint not null,
        block_number bigint not null,
        checkpoint text not null,
        delivery_when text not null,
        body jsonb not null,
        status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        last_error text,
        created_at timestamptz not null default now(),
        delivered_at timestamptz,
        primary key (live, destination, outbox_id, kind)
      );
      create index deliveries_due on tm_outbox.deliveries (live, next_attempt_at) where status = 'pending';
      create index deliveries_status on tm_outbox.deliveries (live, status, created_at);
    `,
  },
];
