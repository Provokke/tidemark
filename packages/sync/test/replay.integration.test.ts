import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startRpcProxy } from "@tidemark/testing";
import { describe, expect, it } from "vitest";
import { type SyncFixture, syncAndCollect } from "./fixture-tools.js";

const dir = join(import.meta.dirname, "fixtures");
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".fixture.json"))
  .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8")) as SyncFixture] as const);

describe("recorded fixtures replay with no node", () => {
  it("has at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("%s", async (_, fixture) => {
    const replay = await startRpcProxy({ replay: fixture.cassette });
    try {
      const expected = await syncAndCollect(replay.url, fixture);
      expect(expected).toEqual(fixture.expected);
      expect(expected.some((e) => e.logs.length > 0)).toBe(true);
    } finally {
      await replay.stop();
    }
  });
});
