/**
 * Live queries through every transport, driven by hand-made commits (rows written, then `tm_commit`
 * notified as the indexer does): WebSocket (graphql-transport-ws), SSE (GET and POST), long-poll.
 */
import { createHash } from "node:crypto";
import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, relations, t, tableDdl } from "@tidemark/schema";
import { type TestDatabase, createTestDatabase } from "@tidemark/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRAPHQL_WS_PROTOCOL, type LiveResult, createApi, serveApi } from "../src/index.js";

const item = onchainTable("item", { id: t.integer().primaryKey(), label: t.text().notNull() });
const other = onchainTable("other", { id: t.integer().primaryKey(), itemId: t.integer().notNull() });
const itemRelations = relations(item, ({ many }) => ({
  others: many(other, { fields: ["id"], references: ["itemId"] }),
}));
const schema = { item, other, itemRelations };

let db: TestDatabase;
let sql: Sql;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = connect(db.url, { max: 10 });
  await sql.unsafe("create schema app");
  for (const table of [item, other]) for (const ddl of tableDdl(table, "app")) await sql.unsafe(ddl);
  await sql.unsafe(`create table app."_tm_checkpoints" (chain_id bigint primary key, block_number bigint not null,
    checkpoint text not null, finalized_block bigint not null, finalized_checkpoint text not null, updated_at timestamptz not null default now())`);
  await sql.unsafe(`insert into app."_tm_checkpoints" values (1, 1, '0', 1, '0', now())`);
  await sql`insert into app.item values (1, 'one')`;
});

afterAll(async () => {
  await sql.end();
  await db.drop();
});

/** What the indexer does at a commit: write, then notify in the same transaction. */
async function commit(statement: string, tables: string[]) {
  await sql.begin(async (tx) => {
    await tx.unsafe(statement);
    await tx.unsafe("select pg_notify('tm_commit', $1)", [JSON.stringify({ schema: "app", tables })]);
  });
}

const until = async <T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("metrics", () => {
  it("labels API requests by route pattern and status", async () => {
    const api = createApi({ sql, schema, databaseSchema: "app" });
    try {
      await api.app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await api.app.request("/no/such/path");
      const text = await (await api.app.request("/metrics")).text();
      expect(text).toMatch(/^tm_api_requests_total\{route="\/graphql",status="400"\} \d+$/m);
      expect(text).toMatch(/^tm_api_requests_total\{route="other",status="404"\} \d+$/m);
      expect(text).toMatch(/^tm_api_request_seconds_count\{route="\/graphql"\} \d+$/m);
    } finally {
      await api.close();
    }
  });
});

describe("live queries", () => {
  it("knows which tables a query reads, and re-runs only for those", async () => {
    const api = createApi({ sql, schema, databaseSchema: "app" });
    try {
      const runs: LiveResult[] = [];
      const { first, unsubscribe } = await api.live.subscribe(
        { graphql: { query: "{ items { nodes { id label } } }" } },
        (r) => runs.push(r),
      );
      expect(first.body).toEqual({ data: { items: { nodes: [{ id: 1, label: "one" }] } } });
      const evaluations = api.live.evaluations;
      // A change to another table: no re-run, no push.
      await commit("insert into app.other values (10, 1)", ["other"]);
      await new Promise((r) => setTimeout(r, 200));
      expect(runs).toHaveLength(1);
      expect(api.live.evaluations).toBe(evaluations);
      // A notice for the table that leaves the result as it was: re-run, but no push.
      await commit("update app.item set label = 'one' where id = 1", ["item"]);
      await until(() => (api.live.evaluations === evaluations + 1 ? true : undefined));
      await new Promise((r) => setTimeout(r, 100));
      expect(runs).toHaveLength(1);
      await commit("insert into app.item values (2, 'two')", ["item"]);
      await until(() => (runs.length === 2 ? true : undefined));
      expect(runs[1]?.body).toEqual({
        data: {
          items: {
            nodes: [
              { id: 1, label: "one" },
              { id: 2, label: "two" },
            ],
          },
        },
      });
      expect(runs[1]?.cursor).not.toBe(runs[0]?.cursor);
      unsubscribe();

      // A nested relation reads both tables; SQL reads what its FROM names.
      const nested: LiveResult[] = [];
      const sub = await api.live.subscribe(
        { graphql: { query: "{ item(id: 1) { others { nodes { id } } } }" } },
        (r) => nested.push(r),
      );
      await commit("insert into app.other values (11, 1)", ["other"]);
      await until(() => (nested.length === 2 ? true : undefined));
      sub.unsubscribe();
      const sqlRuns: LiveResult[] = [];
      const sqlSub = await api.live.subscribe({ sql: { query: "select count(*) as n from other" } }, (r) =>
        sqlRuns.push(r),
      );
      const before = api.live.evaluations;
      await commit("insert into app.item values (3, 'three')", ["item"]);
      await new Promise((r) => setTimeout(r, 200));
      expect(sqlRuns).toHaveLength(1);
      expect(api.live.evaluations).toBe(before);
      await commit("insert into app.other values (12, 3)", ["other"]);
      await until(() => (sqlRuns.length === 2 ? true : undefined));
      expect((sqlRuns[1]?.body as { rows: unknown[][] }).rows).toEqual([["3"]]);
      sqlSub.unsubscribe();
      expect(api.live.size).toBe(0);
    } finally {
      await api.close();
    }
  });

  it("serves WebSocket (graphql-transport-ws), SSE and long-poll", async () => {
    const key = "live-test-key";
    const server = await serveApi({
      sql,
      schema,
      databaseSchema: "app",
      port: 0,
      apiKeyHashes: [createHash("sha256").update(key).digest("hex")],
    });
    const wsUrl = `${server.url.replace("http", "ws")}/graphql/ws`;
    const auth = { authorization: `Bearer ${key}` };
    try {
      // WebSocket without a key: closed with 4403.
      const refused = new WebSocket(wsUrl, GRAPHQL_WS_PROTOCOL);
      const code = await new Promise<number>((resolve) => {
        refused.onopen = () => refused.send(JSON.stringify({ type: "connection_init" }));
        refused.onclose = (e) => resolve(e.code);
      });
      expect(code).toBe(4403);

      // WebSocket with a key: ack, then `next` at once and on every change, until `complete`.
      const ws = new WebSocket(wsUrl, GRAPHQL_WS_PROTOCOL);
      const messages: { type: string; id?: string; payload?: unknown }[] = [];
      ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)) as (typeof messages)[number]);
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
      ws.send(JSON.stringify({ type: "connection_init", payload: auth }));
      await until(() => messages.find((m) => m.type === "connection_ack"));
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: "q1",
          payload: { query: "query($id: Int!) { item(id: $id) { label } }", variables: { id: 4 } },
        }),
      );
      await until(() => messages.find((m) => m.type === "next" && m.id === "q1"));
      expect(messages.filter((m) => m.type === "next")[0]?.payload).toEqual({ data: { item: null } });

      // SSE over POST (fetch), with the key.
      const controller = new AbortController();
      const sseEvents: { cursor: string; body: unknown }[] = [];
      const response = await fetch(`${server.url}/live/sse`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ sql: { query: "select label from item where id = $1", params: [4] } }),
        signal: controller.signal,
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reading = (async () => {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          buffer += new TextDecoder().decode(value);
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").find((l) => l.startsWith("data:"));
            if (frame.includes("event: result") && data !== undefined)
              sseEvents.push(JSON.parse(data.slice(5).trim()) as never);
            end = buffer.indexOf("\n\n");
          }
        }
      })();
      await until(() => (sseEvents.length === 1 ? true : undefined));

      // Long-poll: with the current cursor it waits for a change.
      const first = (await (
        await fetch(`${server.url}/live/poll`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ graphql: { query: "{ item(id: 4) { label } }" } }),
        })
      ).json()) as { changed: boolean; cursor: string; body: unknown };
      expect(first).toMatchObject({ changed: true, body: { data: { item: null } } });
      const waiting = fetch(`${server.url}/live/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ graphql: { query: "{ item(id: 4) { label } }" }, cursor: first.cursor }),
      }).then((r) => r.json() as Promise<{ changed: boolean; body: unknown }>);
      await new Promise((r) => setTimeout(r, 150));

      // One commit: every transport hears it.
      await commit("insert into app.item values (4, 'four')", ["item"]);
      expect(await waiting).toMatchObject({ changed: true, body: { data: { item: { label: "four" } } } });
      await until(() => (messages.filter((m) => m.type === "next").length === 2 ? true : undefined));
      expect(messages.filter((m) => m.type === "next")[1]?.payload).toEqual({
        data: { item: { label: "four" } },
      });
      await until(() => (sseEvents.length === 2 ? true : undefined));
      expect((sseEvents[1]?.body as { rows: unknown[][] }).rows).toEqual([["four"]]);

      // A long-poll with nothing to report answers after its timeout.
      const quiet = (await (
        await fetch(`${server.url}/live/poll`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({
            graphql: { query: "{ item(id: 4) { label } }" },
            cursor: (sseEvents[1] as { cursor: string }).cursor,
            timeoutMs: 100,
          }),
        })
      ).json()) as { changed: boolean };
      expect(quiet.changed).toBe(true); // a different query's cursor: answered at once
      const same = (await (
        await fetch(`${server.url}/live/poll`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ graphql: { query: "{ item(id: 4) { label } }" }, timeoutMs: 100 }),
        })
      ).json()) as { cursor: string };
      const timedOut = (await (
        await fetch(`${server.url}/live/poll`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({
            graphql: { query: "{ item(id: 4) { label } }" },
            cursor: same.cursor,
            timeoutMs: 100,
          }),
        })
      ).json()) as { changed: boolean };
      expect(timedOut.changed).toBe(false);

      // `complete` stops a WebSocket subscription; an invalid query gets `error`; ping gets pong.
      ws.send(JSON.stringify({ type: "complete", id: "q1" }));
      ws.send(JSON.stringify({ type: "subscribe", id: "q2", payload: { query: "{ nope }" } }));
      ws.send(JSON.stringify({ type: "ping" }));
      await until(() => messages.find((m) => m.type === "error" && m.id === "q2"));
      await until(() => messages.find((m) => m.type === "pong"));
      await commit("update app.item set label = 'FOUR' where id = 4", ["item"]);
      await until(() => (sseEvents.length === 3 ? true : undefined));
      expect(messages.filter((m) => m.type === "next")).toHaveLength(2);

      // SSE over GET, the EventSource way, without a key: refused.
      expect(
        (await fetch(`${server.url}/live/sse?graphql=${encodeURIComponent("{ items { totalCount } }")}`))
          .status,
      ).toBe(401);

      ws.close();
      controller.abort();
      await reading;
    } finally {
      await server.close();
    }
  });
});
