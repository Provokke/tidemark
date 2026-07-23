import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Anvil, createTestDatabase, startAnvil } from "../src/index.js";

describe("anvil in parallel", () => {
  it("gives every caller its own chain, even when many start at once", async () => {
    const chains = await Promise.all(Array.from({ length: 8 }, () => startAnvil()));
    try {
      expect(new Set(chains.map((c) => c.rpcUrl)).size).toBe(8);
      // Mine a different number of blocks on each: a shared chain would show up in the heights.
      await Promise.all(chains.map((c, i) => c.testClient.mine({ blocks: i + 1 })));
      const heights = await Promise.all(chains.map((c) => c.publicClient.getBlockNumber()));
      expect(heights).toEqual(chains.map((_, i) => BigInt(i + 1)));
    } finally {
      await Promise.all(chains.map((c) => c.stop()));
    }
  }, 60_000);

  it("reports a block number that includes the block just mined", async () => {
    const anvil = await startAnvil();
    try {
      for (let i = 1; i <= 20; i++) {
        await anvil.testClient.mine({ blocks: 1 });
        expect(await anvil.publicClient.getBlockNumber()).toBe(BigInt(i));
      }
    } finally {
      await anvil.stop();
    }
  });
});

describe("postgres", () => {
  it("creates an isolated database with the features Tidemark relies on", async () => {
    const db = await createTestDatabase();
    try {
      const [version] = await db.sql<{ server_version_num: string }[]>`show server_version_num`;
      // Multiranges need 14; Tidemark supports 16 and newer.
      expect(Number(version?.server_version_num)).toBeGreaterThanOrEqual(160_000);

      // The sync cache stores cached block intervals as int8multirange and subtracts them.
      const [gaps] = await db.sql<{ gaps: string }[]>`
        select (int8multirange(int8range(1, 5), int8range(10, 20)) - int8multirange(int8range(3, 12)))::text as gaps
      `;
      expect(gaps?.gaps).toBe("{[1,3),[12,20)}");

      const [current] = await db.sql<{ current_database: string }[]>`select current_database()`;
      expect(current?.current_database).toBe(db.name);
    } finally {
      await db.drop();
    }
  });

  it("gives each test its own database", async () => {
    const [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      expect(a.name).not.toBe(b.name);
      await a.sql`create table only_in_a (id int)`;
      const [row] = await b.sql<{ exists: boolean }[]>`
        select exists (select 1 from information_schema.tables where table_name = 'only_in_a')
      `;
      expect(row?.exists).toBe(false);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
  });
});

describe("anvil", () => {
  let anvil: Anvil;

  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 31_337 });
  });

  afterAll(async () => {
    await anvil.stop();
  });

  it("answers with the requested chain id", async () => {
    expect(await anvil.publicClient.getChainId()).toBe(31_337);
  });

  it("reorgs: replaced blocks get new hashes and keep their numbers", async () => {
    await anvil.testClient.mine({ blocks: 10 });
    const head = await anvil.publicClient.getBlockNumber();
    const before = await Promise.all(
      [0n, 1n, 2n, 3n].map((back) => anvil.publicClient.getBlock({ blockNumber: head - back })),
    );

    await anvil.reorg(3);

    const after = await Promise.all(
      [0n, 1n, 2n, 3n].map((back) => anvil.publicClient.getBlock({ blockNumber: head - back })),
    );
    expect(await anvil.publicClient.getBlockNumber()).toBe(head);
    // The newest three blocks changed; the one below them is the common ancestor.
    for (const i of [0, 1, 2]) expect(after[i]?.hash).not.toBe(before[i]?.hash);
    expect(after[3]?.hash).toBe(before[3]?.hash);
    // The new branch still links up to the ancestor.
    expect(after[2]?.parentHash).toBe(before[3]?.hash);
  });
});
