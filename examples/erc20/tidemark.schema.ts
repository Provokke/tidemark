import { index, onchainTable, relations, t } from "@tidemark/schema";

export const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  transfersIn: t.integer().notNull(),
  transfersOut: t.integer().notNull(),
});

export const transfer = onchainTable(
  "transfer",
  {
    id: t.text().primaryKey(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    value: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.timestamp().notNull(),
  },
  (tr) => ({ byFrom: index().on(tr.from), byTo: index().on(tr.to) }),
);

export const allowance = onchainTable(
  "allowance",
  {
    id: t.text().primaryKey(),
    owner: t.hex().notNull(),
    spender: t.hex().notNull(),
    value: t.bigint().notNull(),
  },
  (a) => ({ byOwner: index().on(a.owner) }),
);

export const accountRelations = relations(account, ({ many }) => ({
  sent: many(transfer, { fields: ["id"], references: ["from"] }),
  received: many(transfer, { fields: ["id"], references: ["to"] }),
}));
