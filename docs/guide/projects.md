# Writing a project

A project is three files: the config, the tables, and the handlers.

## `tidemark.config.ts`

```ts
import { defineConfig, factory } from "@tidemark/engine";
import { factoryAbi, poolAbi } from "./abis";

export default defineConfig({
  chains: {
    base: {
      id: 8453,
      rpc: [process.env.BASE_RPC_URL!, process.env.BASE_RPC_BACKUP!], // tried in order
      finality: "tag", // or { depth: 64 } for chains without a finalized tag
      verify: "bloom", // or "head-check" (default), "receipts-root"
      strictTimestamps: true, // OP-stack and Ethereum; lets omnichain ordering run without waiting
    },
  },
  ordering: "per-chain", // or "omnichain": one global order across chains, by block timestamp
  contracts: {
    Factory: { chain: "base", abi: factoryAbi, address: "0x...", startBlock: 1371680 },
    Pool: {
      chain: "base",
      abi: poolAbi,
      address: factory({ address: "0x...", event: factoryAbi[0], parameter: "pool" }),
      startBlock: 1371680,
      includeTransaction: true, // event.transaction.from, .to, .value, ...
      includeReceipt: false, // event.receipt.gasUsed, .status, ...
      includeCallTraces: false, // handlers for function calls: "Pool.swap()"
    },
  },
  blocks: { Hourly: { chain: "base", interval: 1800, startBlock: 1371680 } },
  outbox: {/* see outbox.md */},
});
```

RPC URLs, finality, `verify` and the outbox are not part of the build id: changing them does not
re-index anything.

## `tidemark.schema.ts`

```ts
import { index, onchainTable, relations, t } from "@tidemark/schema";

export const pool = onchainTable(
  "pool",
  {
    id: t.hex().primaryKey(),
    token0: t.hex().notNull(),
    fee: t.integer().notNull(),
    liquidity: t.bigint().notNull(), // numeric(78,0): every uint256 fits
    createdAt: t.timestamp().notNull(),
    meta: t.json(),
  },
  (p) => ({ byToken: index().on(p.token0) }),
  { history: true }, // keep every version: reads at any block (querying.md)
);

export const swap = onchainTable("swap", {
  id: t.text().primaryKey(),
  poolId: t.hex().notNull(),
  amount0: t.bigint().notNull(),
});

export const poolRelations = relations(pool, ({ many }) => ({
  swaps: many(swap, { fields: ["id"], references: ["poolId"] }),
}));
```

Column types: `hex` (bytea; `0x` strings, lowercase), `text`, `bigint` (numeric), `integer`, `real`,
`boolean`, `timestamp` (accepts `event.block.timestamp`), `json`.

## `src/index.ts`

```ts
import { tidemark } from "tidemark:registry";
import { pool, swap } from "../tidemark.schema";

tidemark.on("Factory:PoolCreated", async ({ event, context }) => {
  await context.db.insert(pool).values({
    id: event.args.pool,
    token0: event.args.token0,
    fee: event.args.fee,
    liquidity: 0n,
    createdAt: event.block.timestamp,
  });
});

tidemark.on("Pool:Swap", async ({ event, context }) => {
  await context.db.insert(swap).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    poolId: event.log.address,
    amount0: event.args.amount0,
  });
  await context.db
    .update(pool, { id: event.log.address })
    .set((row) => ({ liquidity: event.args.liquidity }));
  if (event.args.amount0 > 10n ** 24n)
    await context.outbox.emit("whale-swap", { pool: event.log.address, amount0: event.args.amount0 });
});
```

`tidemark:registry` is typed from the config: event names autocomplete, arguments have their ABI
types (indexed strings, bytes, arrays and tuples are their hash, as on chain), and an unknown event is
a type error. Run `tidemark codegen` once so your editor sees the types. An overloaded event is named
by its signature: `"Token:Transfer(address,address,uint256)"`.

### What a handler gets

|                                                                                |                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event.args`, `event.log`, `event.block`, `event.transaction`, `event.receipt` | The event, typed.                                                                                                                                                                              |
| `context.db`                                                                   | `insert().values()` (with `onConflictDoNothing()` or `onConflictDoUpdate(fn)`), `update(table, key).set(patch or fn)`, `delete(table, key)`, `find(table, key)`. Journaled: a reorg undoes it. |
| `context.client`                                                               | `readContract`, `call`, `getBalance`, `getCode`, `getStorageAt`, pinned to the event's block, cached for finalised blocks (a re-index makes no RPC calls).                                     |
| `context.outbox.emit(topic, payload, { when })`                                | A side effect, delivered after commit ([outbox.md](outbox.md)).                                                                                                                                |
| `context.chain`                                                                | `{ id, name }`.                                                                                                                                                                                |

Handlers must be deterministic: the same event must always produce the same writes. Use
`event.block.timestamp`, never `Date.now()`, and `context.client`, never your own network calls.

## Testing a project

```ts
import { indexProject, startAnvil } from "@tidemark/testing";

const anvil = await startAnvil();
// deploy your contracts with anvil.walletClient...
const indexed = await indexProject({ tidemark, schema, realtime: true });
await token.write.transfer([alice, 5n]);
await indexed.caughtUp();
expect(await indexed.find(account, { id: alice })).toMatchObject({ balance: 5n });
await anvil.reorg(1); // the block is gone: so is the row
await indexed.caughtUp();
```
