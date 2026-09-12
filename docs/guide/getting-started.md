# Getting started

You need Node.js 24 and a Postgres 16 or newer database. Docker is an easy way to get one:

```bash
docker run -d --name tidemark-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine
```

## Create a project

From a template:

```bash
npx create-tidemark my-indexer --chain-id 1
```

Or from any verified contract. The ABI comes from Sourcify, or from Etherscan with
`--etherscan-key`, and every event gets a table and a handler:

```bash
npx create-tidemark my-indexer --address 0x... --chain-id 8453 --start-block 1371680
```

```bash
cd my-indexer
cp .env.example .env.local   # set the RPC URL and DATABASE_URL
pnpm install
pnpm dev
```

`tidemark dev` indexes the chain and serves the API on <http://127.0.0.1:42069>. Every time you save a
file it rebuilds: a change to the handlers or the tables is a new build, re-indexed from the local
sync cache (no RPC calls for history), and it goes live when it has caught up. Until then the
previous build keeps serving.

## Ask it something

```bash
curl -s localhost:42069/graphql -H 'content-type: application/json' \
  -d '{"query":"{ accounts(orderBy: [{ balance: DESC }], first: 5) { nodes { id balance } } }"}'

curl -s localhost:42069/sql -H 'content-type: application/json' \
  -d '{"query":"select id, balance from account order by balance desc limit 5"}'

curl -s localhost:42069/status
```

## Where next

- [Writing a project](projects.md) explains the three files you just generated.
- [Querying](querying.md) covers the typed client and live queries.
- [Deployment](deployment.md) takes it to production.
