/** `@tidemark/testing`'s `indexProject`, used the way a project's own tests would use it. */
import { tokenAbi, tokenBytecode } from "@tidemark/contracts";
import { onchainTable, t } from "@tidemark/schema";
import { indexProject, startAnvil } from "@tidemark/testing";
import { type Address, getAddress } from "viem";
import { expect, it } from "vitest";
import { createTidemark, defineConfig } from "../src/index.js";

const account = onchainTable("account", { id: t.hex().primaryKey(), balance: t.bigint().notNull() });
const ZERO = "0x0000000000000000000000000000000000000000";
const alice = getAddress("0x00000000000000000000000000000000000a11ce");
const bob = getAddress("0x0000000000000000000000000000000000000b0b");

it("indexes a project, follows new blocks and undoes a reorg", async () => {
  const anvil = await startAnvil();
  const hash = await anvil.walletClient.deployContract({ abi: tokenAbi, bytecode: tokenBytecode });
  const token = (await anvil.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
  const write = async (functionName: "mint" | "transfer", to: Address, amount: bigint) =>
    anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName,
        args: [to, amount],
      }),
    });
  await write("mint", anvil.walletClient.account.address, 10n ** 21n);

  const tidemark = createTidemark(
    defineConfig({
      chains: { anvil: { id: 31_337, rpc: anvil.rpcUrl, finality: { depth: 10 } } },
      contracts: { Token: { chain: "anvil", abi: tokenAbi, address: token, startBlock: 0 } },
    }),
  );
  tidemark.on("Token:Transfer", async ({ event, context }) => {
    const { from, to, value } = event.args;
    if (from !== ZERO)
      await context.db.update(account, { id: from }).set((r) => ({ balance: r.balance - value }));
    await context.db
      .insert(account)
      .values({ id: to, balance: value })
      .onConflictDoUpdate((r) => ({ balance: r.balance + value }));
  });

  const indexed = await indexProject({ tidemark, schema: { account }, realtime: true });
  try {
    await write("transfer", alice, 5n);
    await indexed.caughtUp();
    expect(await indexed.find(account, { id: alice })).toEqual({ id: alice.toLowerCase(), balance: 5n });

    await write("transfer", bob, 7n);
    await indexed.caughtUp();
    expect((await indexed.rows(account)).map((r) => r.id)).toContain(bob.toLowerCase());

    // The block with bob's transfer is replaced by an empty one.
    await anvil.reorg(1);
    await indexed.caughtUp();
    expect(await indexed.find(account, { id: bob })).toBeUndefined();
    expect(await indexed.find(account, { id: alice })).toEqual({ id: alice.toLowerCase(), balance: 5n });
  } finally {
    await indexed.stop();
    await anvil.stop();
  }
}, 60_000);
