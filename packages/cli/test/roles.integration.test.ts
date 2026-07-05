/** `tidemark db init`: the API role can serve a build and nothing else. */
import { randomUUID } from "node:crypto";
import { createLiveApi } from "@tidemark/api";
import {
  buildSchemaName,
  computeBuildId,
  cutover,
  defineConfig,
  prepareIndexSchema,
  registerBuild,
  setBuildStatus,
} from "@tidemark/engine";
import { connect } from "@tidemark/pg";
import { onchainTable, t } from "@tidemark/schema";
import { createTestDatabase, testDatabaseAdminUrl } from "@tidemark/testing";
import { expect, it } from "vitest";
import { initRoles } from "../src/index.js";

const item = onchainTable("item", { id: t.integer().primaryKey(), label: t.text().notNull() });

it("gives the indexer ownership and the API read-only access to builds only", async () => {
  const db = await createTestDatabase();
  const admin = connect(db.url, { max: 2 });
  const prefix = `tmt_${randomUUID().slice(0, 8)}`;
  const roles = await initRoles(admin, db.url, {
    prefix,
    indexerPassword: "indexer-password-1",
    apiPassword: "api-password-12",
  });
  const indexer = connect(roles.indexerUrl, { max: 2 });
  const apiSql = connect(roles.apiUrl, { max: 4 });
  try {
    // The indexer builds and cuts over, as `tidemark start` would.
    const config = defineConfig({ chains: {}, contracts: {} });
    const buildId = computeBuildId({ config, schema: { item }, code: "roles-test" });
    await registerBuild(indexer, buildId, { item });
    await prepareIndexSchema(indexer, buildSchemaName(buildId), [item]);
    await indexer.unsafe(`insert into ${buildSchemaName(buildId)}.item values (1, 'one')`);
    await setBuildStatus(indexer, buildId, "ready");
    await cutover(indexer, "live", buildId);

    // The API, as the API role, serves it.
    const api = await createLiveApi({ sql: apiSql, live: "live" });
    try {
      const res = await api.app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ items { nodes { id label } } }" }),
      });
      expect(await res.json()).toEqual({ data: { items: { nodes: [{ id: 1, label: "one" }] } } });
    } finally {
      await api.close();
    }
    expect(await apiSql.unsafe("select label from live.item")).toEqual([{ label: "one" }]);

    // And can do nothing else.
    const denied = async (statement: string) => {
      const error = (await apiSql.unsafe(statement).then(
        () => undefined,
        (e: unknown) => e,
      )) as { code?: string } | undefined;
      expect({ statement, code: error?.code }).toEqual({ statement, code: "42501" }); // insufficient_privilege
    };
    await denied(`insert into ${buildSchemaName(buildId)}.item values (2, 'two')`);
    await denied(`delete from ${buildSchemaName(buildId)}.item`);
    await denied("select * from tm_sync.intervals");
    await denied("select * from tm_outbox.deliveries");
    await denied("create schema nope");
    await denied("update tm_meta.live_schemas set active_build = null");

    // Running it again is fine (passwords reset, grants re-applied).
    await initRoles(admin, db.url, {
      prefix,
      indexerPassword: "indexer-password-1",
      apiPassword: "api-password-12",
    });
  } finally {
    await apiSql.end();
    await indexer.end();
    await admin.end();
    await db.drop();
    const cluster = connect(testDatabaseAdminUrl(), { max: 1 });
    await cluster.unsafe(`drop role if exists ${prefix}_api`);
    await cluster.unsafe(`drop role if exists ${prefix}_indexer`);
    await cluster.end();
  }
}, 60_000);
