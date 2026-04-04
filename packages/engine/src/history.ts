import { ident } from "@tidemark/pg";
import { type AnyTable, internalTable, t } from "@tidemark/schema";

/**
 * Every block the indexer handled events in, with its timestamp, for projects with history tables:
 * it turns "chain C, block N" into the checkpoint at the end of that block. Journaled like any table,
 * so a reorg removes the blocks it replaced.
 */
export const blocksTable = internalTable("_tm_blocks", {
  id: t.text().primaryKey(),
  chainId: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
});

export const HISTORY_PREFIX = "_tm_history_";

/** Digits after the timestamp in a checkpoint: chain (16), block (16), then 33 more. */
const AFTER_BLOCK = 33;
const AFTER_TIMESTAMP = 65;

/**
 * SQL functions for time travel, in the build schema (so the API's SQL endpoint, whose search path
 * is the build schema, can call them):
 *
 * - `tm_checkpoint_at(chain, block)`: the end of the last block at or before `block` that the
 *   indexer handled events in on that chain (`''`, before everything, if none);
 * - `tm_timestamp_checkpoint(unix_seconds)`: the end of that second, on every chain;
 * - `tm_finalized_checkpoint()`: the lowest finalised checkpoint across chains, so a read at it
 *   never shows data a reorg could change;
 * - `<table>_at(checkpoint)` per history table: the rows as they were at that checkpoint.
 */
export function historyFunctionsDdl(schema: string, tables: readonly AnyTable[]): string[] {
  const s = ident(schema);
  const historyTables = tables.filter((table) => table.name.startsWith(HISTORY_PREFIX));
  if (historyTables.length === 0) return [];
  const statements = [
    `create index ${ident("_tm_blocks_by_chain")} on ${s}."_tm_blocks" (chain_id, block_number)`,
    `create or replace function ${s}.tm_checkpoint_at(p_chain bigint, p_block bigint) returns text
       language sql stable as $$
         select coalesce((
           select lpad(timestamp::text, 10, '0') || lpad(chain_id::text, 16, '0') || lpad(block_number::text, 16, '0') || repeat('9', ${AFTER_BLOCK})
           from ${s}."_tm_blocks" where chain_id = p_chain and block_number <= p_block
           order by block_number desc limit 1), '')
       $$`,
    `create or replace function ${s}.tm_timestamp_checkpoint(p_timestamp bigint) returns text
       language sql immutable as $$ select lpad(p_timestamp::text, 10, '0') || repeat('9', ${AFTER_TIMESTAMP}) $$`,
    `create or replace function ${s}.tm_finalized_checkpoint() returns text
       language sql stable as $$ select coalesce(min(finalized_checkpoint), '') from ${s}."_tm_checkpoints" $$`,
  ];
  for (const history of historyTables) {
    const name = history.name.slice(HISTORY_PREFIX.length);
    statements.push(
      `create index ${ident(`${history.name}_open`)} on ${s}.${ident(history.name)} (tm_valid_from, tm_valid_to)`,
      `create or replace function ${s}.${ident(`${name}_at`)}(p_at text) returns setof ${s}.${ident(history.name)}
         language sql stable as $$
           select * from ${s}.${ident(history.name)}
           where tm_valid_from <= p_at and (tm_valid_to is null or tm_valid_to > p_at)
         $$`,
    );
  }
  return statements;
}
