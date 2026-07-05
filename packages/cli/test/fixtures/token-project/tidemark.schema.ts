import { onchainTable, t } from "@tidemark/schema";

export const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
});
