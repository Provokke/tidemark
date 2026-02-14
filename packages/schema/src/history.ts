import { type AnyColumn, Column, textCodec } from "./columns.js";
import { type AnyTable, internalTable, primaryKey } from "./table.js";

/** Keys of the two columns a history table adds: the checkpoints a version is valid from and to. */
export const HISTORY_FROM = "tmValidFrom";
export const HISTORY_TO = "tmValidTo";

export const historyTableName = (name: string) => `_tm_history_${name}` as const;

const cache = new WeakMap<AnyTable, AnyTable>();

/**
 * The companion of a `{ history: true }` table: every version of every row, each valid from the
 * checkpoint of the event that wrote it until the checkpoint of the next write (open while
 * current). Checkpoints, not block numbers, bound versions: they order events across every chain,
 * so a row that several chains write has one timeline.
 */
export function historyTable(table: AnyTable): AnyTable {
  const cached = cache.get(table);
  if (cached !== undefined) return cached;
  for (const key of [HISTORY_FROM, HISTORY_TO]) {
    if (table.columnList.some((c) => c.key === key)) {
      throw new Error(`table ${table.name}: column ${key} is reserved for history tables`);
    }
  }
  const columns: Record<string, AnyColumn> = {};
  for (const c of table.columnList) {
    // Same codecs; nullability as in the table (key columns are never null).
    const base = new Column(c.column.codec) as AnyColumn;
    columns[c.key] = c.column.isNotNull || table.primaryKey.includes(c.key) ? base.notNull() : base;
  }
  columns[HISTORY_FROM] = new Column(textCodec).notNull() as AnyColumn;
  columns[HISTORY_TO] = new Column(textCodec) as AnyColumn;
  const history = internalTable(historyTableName(table.name), columns, (refs) => ({
    pk: primaryKey({
      columns: [...table.primaryKey, HISTORY_FROM].map((k) => refs[k] as { key: string }) as never,
    }),
  }));
  cache.set(table, history);
  return history;
}
