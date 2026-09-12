# Tidemark

A self-hosted indexer for EVM chains. You describe the contracts you care about, the tables you want and
a few TypeScript handlers; Tidemark syncs the chain, runs your handlers in a strict order, keeps Postgres
correct through reorgs, and serves the result over GraphQL, SQL and live queries.

```ts
tidemark.on("Pool:Swap", async ({ event, context }) => {
  await context.db.insert(swap).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    pool: event.log.address,
    amount0: event.args.amount0,
  });
  await context.db.update(pool, { id: event.log.address }).set((p) => ({ swaps: p.swaps + 1 }));
});
```

## Why

- **Reorgs are handled for you.** Writes above the finalised block are journaled and rolled back
  automatically, across chains and through restarts. A property test hammers this with random reorgs and
  crashes and checks the result against a clean re-index.
- **Redeploys don't touch your RPC bill.** Raw chain data is cached in Postgres, independent of your code.
  Change a handler and the new build re-indexes from the cache, then swaps in with no downtime. Rolling
  back is instant.
- **You can check what providers tell you.**
  - By default, a lagging node can't silently skip blocks.
  - With `bloom` verification, every range answer is checked against block headers.
  - With `receipts-root` verification, logs are derived from receipts proven against the header.
- **It's just Postgres.** No queue, no cache server, no separate database. Query it over GraphQL, guarded
  SQL or a typed Kysely client, or directly.
- **Typed end to end.** Event names and arguments are inferred from your ABIs; an unknown event is a
  compile error.

## Features

- Logs from fixed addresses or factory-created contracts, call traces, block intervals, transactions,
  receipts, and contract reads pinned to the event's block
- Several chains, indexed independently or in one global order
- GraphQL with filters, relations and cursor pagination; a read-only SQL endpoint; a typed client
- Live queries over WebSocket, server-sent events or long-poll, plus React hooks
- Time travel: tables with history can be read at any block, timestamp, or the finalised state
- An outbox for side effects (signed webhooks, SQS, NATS, Kafka) that retracts what a reorg removes
- Hot reload in development, Prometheus metrics, least-privilege database roles
- Docker image, Docker Compose stack with Grafana, Terraform module for AWS, Helm chart

## Quick start

You need Node.js 24 and Postgres 16+.

```bash
npx create-tidemark my-indexer --address 0x... --chain-id 8453   # or --template erc20
cd my-indexer
cp .env.example .env.local    # RPC URL and DATABASE_URL
pnpm install
pnpm dev
```

The API is now on http://127.0.0.1:42069:

```bash
curl -s localhost:42069/graphql -H 'content-type: application/json' \
  -d '{"query":"{ accounts(first: 5, orderBy: [{ balance: DESC }]) { nodes { id balance } } }"}'
```

Edit a handler and save: a new build indexes from the local cache and goes live when it has caught up.

## Documentation

- [Getting started](docs/guide/getting-started.md)
- [Writing a project](docs/guide/projects.md): config, tables, handlers, testing
- [Querying](docs/guide/querying.md): GraphQL, SQL, the client, live queries, React, time travel
- [The outbox](docs/guide/outbox.md)
- [Operations](docs/guide/operations.md): deploys and rollbacks, verification, metrics, CLI reference
- [Deployment](docs/guide/deployment.md): Docker Compose, AWS, Kubernetes, costs
- [Architecture](docs/architecture.md) and [benchmarks](docs/benchmarks.md)

## Performance

On a 4-vCPU machine:

- about 40,000 events per second when indexing from the cache;
- GraphQL p95 of 2–5 ms on a million rows;
- changes reach live queries and webhooks about 60 ms after the block.

See [benchmarks](docs/benchmarks.md).

## Packages

| Package                                                                                                                           |                                                           |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`@tidemark/cli`](packages/cli)                                                                                                   | The `tidemark` command                                    |
| [`create-tidemark`](packages/create-tidemark)                                                                                     | Project scaffolding                                       |
| [`@tidemark/engine`](packages/engine)                                                                                             | Config, typed handler registry, the indexing loop, builds |
| [`@tidemark/schema`](packages/schema)                                                                                             | Table definitions                                         |
| [`@tidemark/api`](packages/api)                                                                                                   | GraphQL, SQL and live query server                        |
| [`@tidemark/client`](packages/client)                                                                                             | Typed client                                              |
| [`@tidemark/react`](packages/react)                                                                                               | React hooks                                               |
| [`@tidemark/outbox`](packages/outbox)                                                                                             | Outbox delivery                                           |
| [`@tidemark/testing`](packages/testing)                                                                                           | Anvil, throwaway databases and reorgs for your tests      |
| [`@tidemark/rpc`](packages/rpc), [`sync`](packages/sync), [`store`](packages/store), [`pg`](packages/pg), [`core`](packages/core) | The layers underneath                                     |

## Developing Tidemark

Requirements: Node.js 24, pnpm (`corepack enable`), [Foundry](https://getfoundry.sh) for `anvil`, and a
Postgres you can create databases in.

```bash
git clone --recurse-submodules https://github.com/Provokke/tidemark && cd tidemark
pnpm install
pnpm build
pnpm lint && pnpm typecheck && pnpm test

docker compose -f infra/compose/docker-compose.test.yml up -d
export TIDEMARK_TEST_DATABASE_URL=postgres://tidemark:tidemark@127.0.0.1:55432/postgres
pnpm test:integration
```

## Licence

[MIT](LICENSE)
