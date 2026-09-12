# Changelog

## 1.0.1

- New projects from `create-tidemark` now include `@types/node`, so `tsc` works on a fresh project
  without installing it by hand.

## 1.0.0

The first release. Tidemark indexes EVM chains into Postgres, keeps them correct through reorgs, and
serves them over GraphQL, SQL and live queries.

- **Sources**: logs from fixed addresses or factory children, call traces, interval blocks,
  transactions and receipts, and `context.client` reads at each event's block. Ordering is per chain
  or omnichain.
- **Correctness**:
  - head-checked range sync, with `bloom` and `receipts-root` verification against headers;
  - a journal that rolls back any reorg above finality, through restarts, across chains;
  - property tests for every invariant.
- **Builds**: every change is a new build, re-indexed from the shared sync cache with no RPC calls.
  Cutover and rollback happen with no downtime, and a hot standby waits on the build lock.
- **API**:
  - GraphQL generated from your tables (filters, relations, keyset pagination, limits);
  - a parser-guarded SQL endpoint, and a typed Kysely client;
  - live queries over WebSocket, SSE and long-poll, and React hooks;
  - time travel on history tables, and finalised-consistent reads.
- **Outbox**: reorg-aware side effects to signed webhooks (SSRF-guarded), SQS, NATS and Kafka, with
  retractions, retries, dead letters and redrive.
- **Developer experience**:
  - `create-tidemark` from a template or a verified contract;
  - `tidemark dev` with hot reload from cache, and a typed handler registry;
  - `@tidemark/testing` with reorg injection.
- **Operations**:
  - Prometheus metrics, alert rules and a Grafana dashboard;
  - least-privilege database roles;
  - sync cache export/import to S3 and `tidemark verify`.
- **Deployment**: an image; a Compose stack; a Terraform module for AWS (no NAT gateway, API Gateway
  without a load balancer, alarms, OIDC deploys); a Helm chart.
