# erc20

A [Tidemark](https://github.com/Provokke/tidemark) project.

```bash
cp .env.example .env.local   # then set MAINNET_RPC_URL and DATABASE_URL
pnpm install
pnpm dev                     # indexes, serves the API on http://127.0.0.1:42069, reloads on save
```

- `tidemark.config.ts`: chains and contracts.
- `tidemark.schema.ts`: tables. Each becomes a GraphQL type and a SQL table.
- `src/index.ts`: handlers. `tidemark` from `tidemark:registry` is typed from the config;
  run `pnpm codegen` once so your editor knows it.
