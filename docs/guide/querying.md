# Querying

## GraphQL

`POST /graphql`. Every table gets a single-row field and a connection:

```graphql
{
  pool(id: "0x...") {
    id
    fee
    liquidity
    swaps(first: 5, orderBy: [{ amount0: DESC }]) {
      nodes {
        amount0
      }
    }
  }
  pools(
    where: { fee: { eq: 500 }, swaps: { some: { amount0: { gt: "1000000" } } } }
    orderBy: [{ liquidity: DESC }]
    first: 20
    after: "..."
  ) {
    totalCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      liquidity
    }
  }
  _meta {
    chains {
      chainId
      blockNumber
      finalizedBlock
    }
  }
}
```

Filters: `eq ne in notIn gt gte lt lte contains startsWith isNull`, combined with `AND`, `OR`, `NOT`,
and relation filters (`some`, `none`, `every`). Big integers are decimal strings. Depth, cost and page
size are limited (`ApiLimits`).

## SQL

`POST /sql` with `{ "query": "...", "params": [...] }`: one `SELECT` (CTEs allowed) over your tables,
checked by Postgres's own parser against an allowlist of tables and functions, run read-only with a
timeout and a row cap.

## The typed client

```ts
import { createClient } from "@tidemark/client";
import * as schema from "./tidemark.schema";

const client = createClient({ url: "https://indexer.example.com", apiKey: process.env.API_KEY }, schema);
const top = await client.db.selectFrom("pool").selectAll().orderBy("liquidity", "desc").limit(10).execute();
```

`client.db` is a [Kysely](https://kysely.dev) query builder typed from your tables, compiled to SQL
and run on `/sql`. `client.graphql(query, variables)` and `client.sql(text, params)` are there too.

## Live queries

A live query sends its result at once and again whenever it changes (a commit, a reorg, a cutover),
usually within 100 ms of the block. It re-runs only when a table it reads changed.

```ts
const stop = client.live(
  client.db.selectFrom("pool").selectAll().orderBy("liquidity", "desc").limit(10),
  (rows) => render(rows),
);
```

| Transport          | Endpoint                                        | When                                                                                                 |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| WebSocket          | `/graphql/ws`, `graphql-transport-ws` protocol  | Any `graphql-ws` client; every operation is live.                                                    |
| Server-sent events | `GET /live/sse?graphql=...` or `POST /live/sse` | Browsers (`EventSource`), `client.live` (default).                                                   |
| Long-poll          | `POST /live/poll` with `cursor`                 | Behind proxies that cut long connections (API Gateway). `client.live(q, fn, { transport: "poll" })`. |

### React

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TidemarkProvider, useLiveQuery } from "@tidemark/react";

function Leaderboard() {
  const { data } = useLiveQuery(
    client.db.selectFrom("pool").selectAll().orderBy("liquidity", "desc").limit(10),
  );
  return (
    <ol>
      {data?.map((p) => (
        <li key={p.id}>{p.id}</li>
      ))}
    </ol>
  );
}

<QueryClientProvider client={new QueryClient()}>
  <TidemarkProvider client={client}>
    <Leaderboard />
  </TidemarkProvider>
</QueryClientProvider>;
```

## Time travel

Tables with `{ history: true }` can be read as they were:

```graphql
{
  pool(id: "0x...", at: { block: "21000000" }) {
    liquidity
  }
}
{
  pools(at: { timestamp: 1767225600 }) {
    nodes {
      id
      liquidity
    }
  }
}
{
  pools(at: { finalized: true }) {
    totalCount
  }
} # nothing a reorg could change
```

One point in time per request; `chainId` is needed with `block` when the project has several chains.
In SQL: `select * from pool_at(tm_checkpoint_at(8453, 21000000))`, `tm_timestamp_checkpoint(unix)`,
`tm_finalized_checkpoint()`.

## Status

`GET /status` (each chain's block, finalised block and lag), `/healthz`, `/readyz`, and `/metrics`
(Prometheus).
