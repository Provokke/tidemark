# Benchmarks

Measured on 2026-11-03 on a 4-vCPU Intel Xeon (2.3 GHz) container with Node.js 24 and Postgres 16 on
the same host. Re-run them with `pnpm --filter @tidemark/bench run erc20` and `run api`; the nightly
workflow publishes them as a build artefact.

## Indexing throughput (`bench/erc20.ts`)

100,001 ERC-20 transfers indexed from the sync cache (balances and a transfer table, so every event
reads and writes):

| Run | Events / s |
| --- | ---------- |
| 1   | 46,734     |
| 2   | 41,997     |
| 3   | 38,377     |

The target is 30,000 events/s. The spread is noise from a shared host.

## API latency (`bench/api.ts`)

GraphQL against 1,000,000 rows, 300 runs each:

| Query                               | p50 (ms) | p95 (ms) | p99 (ms) |
| ----------------------------------- | -------- | -------- | -------- |
| Primary key                         | 1.57     | 2.29     | 3.62     |
| Indexed filter + order, 20 rows     | 1.78     | 3.47     | 4.41     |
| Keyset page 500 rows deep           | 2.00     | 3.73     | 6.54     |
| Range filter on block, 50 rows      | 1.62     | 2.68     | 4.95     |
| 10 pools with 5 swaps each (nested) | 2.73     | 4.66     | 7.42     |

The target is p95 under 150 ms.

## Realtime

From a transaction's block being mined to the change arriving (Anvil, 50 ms polling):

| Path                                                                           | Latency  |
| ------------------------------------------------------------------------------ | -------- |
| Live query (WebSocket), `packages/engine/test/live.integration.test.ts`        | 50–65 ms |
| Outbox `latest` webhook, `packages/outbox/test/outbox-e2e.integration.test.ts` | ~60 ms   |

The target is under 1 s after the block is first seen.
