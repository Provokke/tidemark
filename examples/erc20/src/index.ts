import { tidemark } from "tidemark:registry";
import { account, allowance, transfer } from "../tidemark.schema";

const ZERO = "0x0000000000000000000000000000000000000000";

tidemark.on("Token:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  await context.db.insert(transfer).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    from,
    to,
    value,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
  if (from !== ZERO) {
    await context.db
      .insert(account)
      .values({ id: from, balance: -value, transfersIn: 0, transfersOut: 1 })
      .onConflictDoUpdate((row) => ({ balance: row.balance - value, transfersOut: row.transfersOut + 1 }));
  }
  await context.db
    .insert(account)
    .values({ id: to, balance: value, transfersIn: 1, transfersOut: 0 })
    .onConflictDoUpdate((row) => ({ balance: row.balance + value, transfersIn: row.transfersIn + 1 }));
});

tidemark.on("Token:Approval", async ({ event, context }) => {
  const { owner, spender, value } = event.args;
  await context.db
    .insert(allowance)
    .values({ id: `${owner}-${spender}`, owner, spender, value })
    .onConflictDoUpdate(() => ({ value }));
});
