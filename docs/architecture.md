# Architecture

```
            RPC providers (failover, rate limits, head checks, verification)
                                   │
                ┌──────────────────▼──────────────────┐
                │ sync: historical ranges, realtime   │──► tm_sync (shared cache:
                │ follower with reorg detection       │    logs, headers, traces, reads)
                └──────────────────┬──────────────────┘
                                   │ ordered events
                ┌──────────────────▼──────────────────┐
                │ engine: your handlers, in order     │──► tm_build_<id> (your tables,
                │ buffered store + reorg journal      │    history, outbox, journal)
                └──────────────────┬──────────────────┘
                                   │ tm_commit notifications
     ┌─────────────────────────────┼──────────────────────────────┐
     ▼                             ▼                              ▼
  API: GraphQL, SQL,          live schema `live`             outbox dispatcher:
  live queries ──────────────► (views of the active build)   webhooks, SQS, NATS, Kafka
```

Everything stateful lives in Postgres. There is no Redis and no queue to run.

## Ordering

Every event has a 75-digit **checkpoint**:

- block timestamp;
- chain id;
- block number;
- transaction index;
- event type (transaction, trace, log, block);
- position in the transaction.

Sorting checkpoints as strings gives the exact order handlers run in. That order is the same for a
historical run and a realtime one, so a project indexed either way ends up in the same state. With
`ordering: "omnichain"` events from every chain share that order.

## Correctness through reorgs

Below the finalised block nothing is journaled, and writes are batched and copied in with `COPY`. Above
it, a trigger records every row's previous state in a per-table journal. A reorg rolls every affected
chain back in a single pass, which restores rows that more than one chain touched correctly. Restarts
roll back to the last finalised checkpoint the same way.

The central test is a property test. It runs random sequences of transfers, mining, reorgs, restarts
and reorgs while stopped, and the resulting tables must equal a from-scratch index of the final chain.

## The sync cache

Raw finalised data (logs, headers, traces, transactions, receipts and `context.client` reads) is cached
in `tm_sync` by source, with the covered blocks kept as a Postgres multirange. The cache is independent
of your handlers: a new build re-indexes from it without RPC calls, and it can be exported to S3 to seed
another deployment.

## Builds

The build id is a hash of:

- the engine version;
- the config, without RPC URLs or finality settings;
- the table definitions;
- the bundled handler code.

Each build indexes into its own schema. The `live` schema is a set of views over one build, switched in
a transaction. The API resolves the active build itself and queries its schema directly, so a request
never sees tables change under it during a cutover. Rolling back points the views at the previous build.

## History

Tables with `{ history: true }` keep every version of every row in a companion table, valid from the
checkpoint of the write that created it to the checkpoint of the next one. Checkpoints rather than block
numbers bound the versions, so one timeline works across chains. The companion table is journaled like
any other, so reorgs undo versions too.

## Outbox ids

An outbox message's id is a hash of:

- the chain;
- the block hash;
- the checkpoint;
- the topic;
- the position among the event's emits.

It deliberately excludes the build, so a redeploy regenerates the same ids and sends nothing twice. It
includes the block hash, so an event replaced by a reorg gets a new id while the old one is retracted.
