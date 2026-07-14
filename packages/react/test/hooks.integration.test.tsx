// @vitest-environment happy-dom
/** The hooks against a real API: a live query re-renders its component when a commit changes it. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { serveApi } from "@tidemark/api";
import { createClient } from "@tidemark/client";
import { type Sql, connect } from "@tidemark/pg";
import { onchainTable, t, tableDdl } from "@tidemark/schema";
import { type TestDatabase, createTestDatabase } from "@tidemark/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TidemarkProvider, useLiveQuery, useTidemarkQuery } from "../src/index.js";

const score = onchainTable("score", { id: t.text().primaryKey(), points: t.bigint().notNull() });
const schema = { score };

let db: TestDatabase;
let sql: Sql;
let server: Awaited<ReturnType<typeof serveApi>>;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = connect(db.url);
  await sql.unsafe("create schema app");
  for (const ddl of tableDdl(score, "app")) await sql.unsafe(ddl);
  await sql`insert into app.score values ('ada', 3)`;
  server = await serveApi({ sql, schema, databaseSchema: "app", port: 0, cors: true });
});

afterAll(async () => {
  cleanup();
  await server.close();
  await sql.end();
  await db.drop();
});

it("renders query results and live updates", async () => {
  const client = createClient({ url: server.url }, schema);
  const queryClient = new QueryClient();

  function Leaderboard() {
    const { data } = useLiveQuery<{ id: string; points: bigint }[]>(
      client.db.selectFrom("score").selectAll().orderBy("points", "desc"),
    );
    return (
      <ol>
        {data?.map((row) => (
          <li key={row.id}>{`${row.id}:${row.points}`}</li>
        ))}
      </ol>
    );
  }
  function Total() {
    const { data } = useLiveQuery<{ scores: { totalCount: number } }>(
      { graphql: "{ scores { totalCount } }" },
      { transport: "poll" },
    );
    return <p>{`total ${data?.scores.totalCount ?? "?"}`}</p>;
  }
  function Once() {
    const { data } = useTidemarkQuery<{ n: bigint }[]>({ sql: "select count(*) as n from score" });
    return <p>{`once ${data?.[0]?.n ?? "?"}`}</p>;
  }

  render(
    <QueryClientProvider client={queryClient}>
      <TidemarkProvider client={client}>
        <Leaderboard />
        <Total />
        <Once />
      </TidemarkProvider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("ada:3")).toBeTruthy();
  expect(await screen.findByText("total 1")).toBeTruthy();
  expect(await screen.findByText("once 1")).toBeTruthy();

  await act(async () => {
    await sql.begin(async (tx) => {
      await tx`insert into app.score values ('bob', 12345678901234567890)`;
      await tx.unsafe(`select pg_notify('tm_commit', '{"schema":"app","tables":["score"]}')`);
    });
  });
  expect(await screen.findByText("bob:12345678901234567890", {}, { timeout: 5_000 })).toBeTruthy();
  expect(await screen.findByText("total 2", {}, { timeout: 5_000 })).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "bob:12345678901234567890",
    "ada:3",
  ]);
  // A one-off query does not follow commits.
  expect(screen.getByText("once 1")).toBeTruthy();
  cleanup();
  queryClient.clear();
});
