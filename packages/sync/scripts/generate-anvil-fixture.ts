/**
 * Regenerates test/fixtures/anvil-emitter.fixture.json: a deterministic scenario on Anvil, recorded
 * through a proxy that refuses wide ranges Alchemy-style, so the cassette includes refusals and the
 * replay exercises adaptive range sizing. Needs Foundry and TIDEMARK_TEST_DATABASE_URL.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitterAbi, emitterBytecode } from "@tidemark/contracts";
import { startAnvil, startRpcProxy } from "@tidemark/testing";
import { type Address, toEventSelector } from "viem";
import { recordFixture } from "../test/fixture-tools.js";

const anvil = await startAnvil({ chainId: 31_337 });
const limited = await startRpcProxy({
  target: anvil.rpcUrl,
  faults: { maxLogRange: 16, rangeErrorStyle: "alchemy" },
});
try {
  const hash = await anvil.walletClient.deployContract({ abi: emitterAbi, bytecode: emitterBytecode });
  const emitter = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  for (let i = 0; i < 60; i++) {
    if (i % 4 === 3) {
      await anvil.testClient.mine({ blocks: 1 });
      continue;
    }
    const tx = await anvil.walletClient.writeContract({
      address: emitter,
      abi: emitterAbi,
      functionName: "emitMany",
      args: ["0x000000000000000000000000000000000000dEaD", BigInt(1 + (i % 3))],
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: tx });
  }
  await anvil.testClient.mine({ blocks: 64 });
  const target = Number((await anvil.publicClient.getBlock({ blockTag: "finalized" })).number);

  const fixture = await recordFixture(limited.url, {
    description: "Emitter.Simple on Anvil, recorded through a 16-block Alchemy-style range limit",
    chainId: 31_337,
    target,
    maxLogRange: 64,
    sources: [
      {
        filter: {
          chainId: 31_337,
          address: emitter.toLowerCase() as `0x${string}`,
          topics: [toEventSelector("Simple(address,address,uint256)")],
        },
        startBlock: 0,
      },
    ],
  });
  const out = join(import.meta.dirname, "..", "test", "fixtures", "anvil-emitter.fixture.json");
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${out}: ${Object.keys(fixture.cassette).length} answers, ${fixture.expected[0]?.logs.length} logs`,
  );
} finally {
  await limited.stop();
  await anvil.stop();
}
