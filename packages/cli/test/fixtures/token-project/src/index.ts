import { tidemark } from "tidemark:registry";
import { account } from "../tidemark.schema";

const ZERO = "0x0000000000000000000000000000000000000000";

tidemark.on("Token:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  const credit = value * 1n;
  if (from !== ZERO) {
    await context.db.update(account, { id: from }).set((row) => ({ balance: row.balance - credit }));
  }
  await context.db
    .insert(account)
    .values({ id: to, balance: credit })
    .onConflictDoUpdate((row) => ({ balance: row.balance + credit }));
});

/** Never called: checks that the registry is typed from the config. */
export function typesOnly(): void {
  // @ts-expect-error: Token has no such event.
  tidemark.on("Token:NoSuchEvent", async () => {});
}
