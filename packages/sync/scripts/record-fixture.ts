/**
 * Records a historical-sync fixture from a real chain, for the replay test in
 * test/replay.integration.test.ts. Needs TIDEMARK_TEST_DATABASE_URL for a scratch database.
 *
 *   pnpm --filter @tidemark/sync run fixture:record -- \
 *     --rpc https://... --chain-id 8453 --address 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 \
 *     --topic0 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef \
 *     --from 20000000 --to 20000500 --max-log-range 500 \
 *     --description "USDC transfers on Base" --out test/fixtures/base-usdc.fixture.json
 *
 * --to must be at or below the chain's finalised block. The RPC URL is not written to the file.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Hex } from "@tidemark/core";
import { recordFixture } from "../test/fixture-tools.js";

const { values } = parseArgs({
  options: {
    rpc: { type: "string" },
    "chain-id": { type: "string" },
    address: { type: "string", multiple: true },
    topic0: { type: "string", multiple: true },
    from: { type: "string" },
    to: { type: "string" },
    "max-log-range": { type: "string", default: "2000" },
    description: { type: "string", default: "" },
    out: { type: "string" },
  },
});

const required = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new Error(`--${name} is required`);
  return value;
};

const fixture = await recordFixture(required("rpc"), {
  description: values.description,
  chainId: Number(required("chain-id")),
  target: Number(required("to")),
  maxLogRange: Number(values["max-log-range"]),
  sources: [
    {
      filter: {
        chainId: Number(required("chain-id")),
        ...(values.address === undefined ? {} : { address: values.address as Hex[] }),
        ...(values.topic0 === undefined ? {} : { topics: [values.topic0 as Hex[]] }),
      },
      startBlock: Number(required("from")),
    },
  ],
});
writeFileSync(required("out"), `${JSON.stringify(fixture, null, 1)}\n`);
const logs = fixture.expected.reduce((n, e) => n + e.logs.length, 0);
console.log(`recorded ${Object.keys(fixture.cassette).length} RPC answers and ${logs} logs to ${values.out}`);
