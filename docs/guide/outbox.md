# Side effects: the outbox

A handler must not call other systems itself: a reorg would undo the data and leave the effect done.
It emits instead, and Tidemark delivers after the data is committed:

```ts
await context.outbox.emit("whale-swap", { pool: event.log.address, amount0: event.args.amount0 });
await context.outbox.emit("price-tick", { price }, { when: "latest" });
```

- `when: "finalized"` (the default): delivered once the block is final. Never retracted.
- `when: "latest"`: delivered at once. If a reorg removes the block, a `<topic>.retracted` message
  with the same `id` follows, so the receiver can undo.

Ids are deterministic (chain, block hash, position, topic), the same in every build: a redeploy
re-sends nothing, and receivers dedupe on `id`. Delivery is at least once.

## Destinations

```ts
outbox: {
  destinations: {
    hooks: { kind: "webhook", url: "https://example.com/tidemark", secrets: [process.env.WEBHOOK_SECRET!] },
    queue: { kind: "sqs", queueUrl: "https://sqs.eu-west-1.amazonaws.com/123/events.fifo", region: "eu-west-1" },
    bus: { kind: "nats", servers: "nats://nats:4222", subject: "tidemark.events" }, // needs `nats`
    log: { kind: "kafka", brokers: ["kafka:9092"], topic: "tidemark-events" }, // needs `kafkajs`
    mine: { kind: "custom", send: async (delivery) => { /* throw to retry */ } },
  },
  routes: { "whale-swap": ["hooks", "queue"], "*": ["log"] },
  maxAttempts: 12,
}
```

## The message

```json
{
  "id": "obx_9f2c...",
  "type": "whale-swap",
  "specVersion": "1",
  "build": "3a71c0...",
  "chainId": 8453,
  "block": { "number": "21544120", "hash": "0x...", "timestamp": 1793664000, "finalized": true },
  "checkpoint": "1793664000...",
  "data": { "pool": "0x...", "amount0": "1250000000000000000000000" }
}
```

## Receiving webhooks

Each request is signed: `Tidemark-Signature: t=<unix>,v1=<hmac>[,v1=<hmac>]`, one HMAC-SHA256 of
`"<t>.<raw body>"` per secret (so you can rotate). Check it against the raw body:

```ts
import { verifySignature } from "@tidemark/outbox";

if (!verifySignature(rawBody, req.headers["tidemark-signature"], [process.env.WEBHOOK_SECRET]))
  return res.status(401).end();
```

Answer 2xx when done. 408, 425, 429 and 5xx are retried with backoff; other answers, redirects
(never followed) and URLs that resolve to private, loopback, link-local or metadata addresses go dead
at once. `insecure: true` allows `http:` and private addresses, for development only.

## Operating it

One process per live schema delivers (`tidemark start`, `deploy` and `dev` run the dispatcher when
the config has an `outbox`); others wait. `tidemark outbox list --status dead` shows failures;
`tidemark outbox redrive [--id obx_...]` queues them again.
