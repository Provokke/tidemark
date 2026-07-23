import { randomBytes } from "node:crypto";
import postgres from "postgres";

export const TEST_DATABASE_URL_ENV = "TIDEMARK_TEST_DATABASE_URL";

export interface TestDatabase {
  /** Connection URL for the new database. */
  readonly url: string;
  readonly name: string;
  readonly sql: postgres.Sql;
  /** Close connections and drop the database. */
  drop(): Promise<void>;
}

/**
 * The admin URL integration tests create their databases through. CI sets it to a Postgres
 * service container; locally, `infra/compose/docker-compose.test.yml` provides one.
 */
export function testDatabaseAdminUrl(): string {
  const url = process.env[TEST_DATABASE_URL_ENV];
  if (url === undefined || url === "") {
    throw new Error(
      `${TEST_DATABASE_URL_ENV} is not set. Start a database with ` +
        "`docker compose -f infra/compose/docker-compose.test.yml up -d` and set " +
        `${TEST_DATABASE_URL_ENV}=postgres://tidemark:tidemark@127.0.0.1:55432/postgres`,
    );
  }
  return url;
}

/** Creates a fresh, uniquely named database so tests can run in parallel without sharing state. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testDatabaseAdminUrl();
  const name = `tm_test_${randomBytes(6).toString("hex")}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });

  return {
    url: url.toString(),
    name,
    sql,
    async drop() {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => undefined });
      try {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
