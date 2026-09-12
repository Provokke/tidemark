# Operations

## Builds, deploys and rollbacks

Every change that can change what indexing writes (handlers, tables, contracts, the engine version)
is a new **build**, with its own schema `tm_build_<id>`. Builds share the sync cache, so a new build
re-indexes history with no RPC calls. A **live schema** (`live`) points at one build; the API serves
whatever it points at, and switches without a restart.

|                                                         |                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tidemark start`                                        | Run the current build (resume if it exists); make it live if nothing is.                       |
| `tidemark deploy`                                       | Run the current build and make it live once it has caught up. The old build serves until then. |
| `tidemark deploy --exit-when-live`                      | The same as a one-off task: exit once live (then roll the services).                           |
| `tidemark promote <id>` / `tidemark rollback`           | Point the live schema at a build, or back at the previous one. Instant.                        |
| `tidemark builds list` / `builds prune --older-than 7d` | Builds that are neither live nor the rollback target can be dropped.                           |

A second indexer for the same build waits on its advisory lock and takes over if the first stops.

## Verification

Per chain, `verify` decides how far historical `eth_getLogs` answers are trusted:

- `head-check` (default): ranges past the node's head are refused, so a lagging node cannot skip
  blocks.
- `bloom`: every block's logs are checked against its header's bloom; a block a range answer left
  out is refetched.
- `receipts-root`: logs come from receipts proven against each header's receipts root. Slow, exact.

`tidemark verify --chain base --from N --to M --mode receipts-root` re-checks what is cached, after a
provider incident or as an audit; `--repair` forgets bad blocks so the next run fetches them again.

## The sync cache

`tidemark cache stats`; `tidemark cache export s3://bucket/prefix [--chain base]` and
`tidemark cache import s3://bucket/prefix` (or a directory) to seed a new deployment without
re-fetching history. S3-compatible stores take `--s3-endpoint`.

## Metrics and alerts

`/metrics` on the API (and on `--metrics-port` for an indexer without an API) serves Prometheus:

| Metric                                                                                                                    |                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `tm_events_total{chain,event}`, `tm_handler_seconds{event}`                                                               | Indexing throughput and handler cost. |
| `tm_processed_block`, `tm_head_block`, `tm_finalized_block`, `tm_realtime_lag_blocks` `{chain}`                           | Where each chain is.                  |
| `tm_reorgs_total{chain}`, `tm_reorg_depth_blocks{chain}`                                                                  | Reorgs rolled back.                   |
| `tm_rpc_requests_total{chain,method,endpoint,outcome}`, `tm_rpc_request_seconds`                                          | RPC health per endpoint.              |
| `tm_flush_seconds`, `tm_flush_rows_total{op}`                                                                             | Database writes.                      |
| `tm_api_requests_total{route,status}`, `tm_api_request_seconds{route}`, `tm_live_queries`, `tm_sql_rejected_total`        | The API.                              |
| `tm_outbox_deliveries_total{destination,kind,outcome}`, `tm_outbox_deliveries{live,status}`, `tm_outbox_delivery_seconds` | The outbox.                           |

`infra/compose/prometheus/alerts.yml` and `infra/compose/grafana/dashboards/tidemark.json` are ready
to use; the AWS module creates the equivalent CloudWatch alarms and dashboard. Logs are JSON lines
with `TIDEMARK_LOG_FORMAT=json` (the image's default).

## Database roles

`tidemark db init` (as an admin; passwords from `TIDEMARK_INDEXER_PASSWORD`, `TIDEMARK_API_PASSWORD`)
creates `tm_indexer`, which owns everything, and `tm_api`, which can read builds, live views and
`tm_meta` and nothing else: no writes, no sync cache, no outbox. Run the indexer as the first and the
API as the second.

## CLI reference

```text
tidemark dev | start [--serve] | serve | deploy [--exit-when-live] | build
tidemark promote <build> | rollback | builds list | builds prune [--older-than 7d]
tidemark codegen | db migrate | db init
tidemark cache stats | cache export <to> | cache import <from>
tidemark verify --chain <c> [--from] [--to] [--mode bloom|receipts-root] [--repair]
tidemark outbox list [--status] | outbox redrive [--id ...]
  --root --database-url --live --port --host --metrics-port --json
```

`DATABASE_URL`, or libpq's `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`.
`TIDEMARK_API_KEY_HASHES` (SHA-256 digests, comma-separated) closes the API;
`TIDEMARK_PUBLIC_METRICS=true` leaves `/metrics` open for a private scraper.
