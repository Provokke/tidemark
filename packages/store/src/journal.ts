import { type TransactionSql, ident } from "@tidemark/pg";
import type { AnyTable } from "@tidemark/schema";

/**
 * The reorg journal: for every user table, a table of row changes made above the finalised block,
 * written by a row trigger. A change is journaled only when the transaction has set
 * `tm.journal = on`, with the chain and block in `tm.chain` and `tm.block`; historical writes,
 * which can never be reorged, skip it.
 *
 * The journal holds the row as it was before the change (or, for an insert, the new row, of which
 * only the key matters). Rolling back to a block restores, for every key touched above it, the
 * state before the oldest change: deleted if that change was an insert, the old row otherwise.
 */

export const journalTable = (table: AnyTable) => `_tm_journal_${table.name}`;

export function journalDdl(schema: string, tables: readonly AnyTable[]): string[] {
  const s = ident(schema);
  const statements = [
    `create or replace function ${s}."_tm_journal"() returns trigger language plpgsql as $f$
begin
  if current_setting('tm.journal', true) is distinct from 'on' then
    return null;
  end if;
  execute format('insert into %I.%I (chain_id, block_number, op, row) values ($1, $2, $3, $4)',
                 tg_table_schema, '_tm_journal_' || tg_table_name)
    using current_setting('tm.chain')::bigint,
          current_setting('tm.block')::bigint,
          case tg_op when 'INSERT' then 'I' when 'UPDATE' then 'U' else 'D' end,
          case tg_op when 'INSERT' then to_jsonb(new) else to_jsonb(old) end;
  return null;
end
$f$`,
  ];
  for (const table of tables) {
    const journal = `${s}.${ident(journalTable(table))}`;
    statements.push(
      `create table ${journal} (
  seq bigserial primary key,
  chain_id bigint not null,
  block_number bigint not null,
  op "char" not null,
  row jsonb not null
)`,
      `create index ${ident(`${journalTable(table)}_block`)} on ${journal} (chain_id, block_number)`,
      // The WHEN clause is checked without calling the function, so historical writes, which never
      // journal, pay almost nothing for the trigger.
      `create trigger "_tm_journal" after insert or update or delete on ${s}.${ident(table.name)}
  for each row when (current_setting('tm.journal', true) = 'on') execute function ${s}."_tm_journal"()`,
    );
  }
  return statements;
}

/** Sets the journaling context for the rest of the transaction. */
export async function enableJournal(tx: TransactionSql, chainId: number, block: number): Promise<void> {
  await tx`select set_config('tm.journal', 'on', true), set_config('tm.chain', ${String(chainId)}, true),
                  set_config('tm.block', ${String(block)}, true)`;
}

/**
 * Undoes every journaled change of `chainId` above `toBlock`, in every table, and removes those
 * journal entries. Runs with journaling off, so the undo is not itself journaled.
 */
export async function rollbackJournal(
  tx: TransactionSql,
  schema: string,
  tables: readonly AnyTable[],
  chainId: number,
  toBlock: number,
): Promise<number> {
  return rollbackJournalMany(tx, schema, tables, [{ chainId, toBlock }]);
}

/**
 * Undoes the journaled changes of several chains at once: for each, everything above its block.
 * One pass over all of them, because a row two chains both changed must go back to the state
 * before the oldest of those changes, whichever chain made it. (The journal's sequence is global
 * per table, so "oldest" is well defined across chains.) Rolling chains back one at a time would
 * instead leave the second chain's pre-image, which already contains the first chain's change.
 */
export async function rollbackJournalMany(
  tx: TransactionSql,
  schema: string,
  tables: readonly AnyTable[],
  targets: readonly { chainId: number; toBlock: number }[],
): Promise<number> {
  if (targets.length === 0) return 0;
  await tx`select set_config('tm.journal', 'off', true)`;
  const s = ident(schema);
  const params = targets.flatMap((t) => [t.chainId, t.toBlock]);
  const scope = targets
    .map((_, i) => `(chain_id = $${2 * i + 1} and block_number > $${2 * i + 2})`)
    .join(" or ");
  let undone = 0;
  for (const table of tables) {
    const target = `${s}.${ident(table.name)}`;
    const journal = `${s}.${ident(journalTable(table))}`;
    const keys = table.primaryKey.map((k) => table.columnList.find((c) => c.key === k)?.sqlName ?? k);
    const undo = ident(`_tm_undo_${table.name}`);
    const keyExprs = keys.map((k, i) => `(jsonb_populate_record(null::${target}, row)).${ident(k)} as k${i}`);
    const keyRefs = keys.map((_, i) => `k${i}`);

    const created = await tx.unsafe(
      `create temp table ${undo} on commit drop as
         select distinct on (${keyRefs.join(", ")}) op, row, ${keyRefs.join(", ")}
         from (select seq, op, row, ${keyExprs.join(", ")} from ${journal} where ${scope}) j
         order by ${keyRefs.join(", ")}, seq asc`,
      params,
    );
    undone += created.count;
    if (created.count === 0) {
      await tx.unsafe(`drop table ${undo}`);
      continue;
    }
    await tx.unsafe(
      `delete from ${target} t using ${undo} u where ${keys.map((k, i) => `t.${ident(k)} = u.k${i}`).join(" and ")}`,
    );
    await tx.unsafe(
      `insert into ${target} select (jsonb_populate_record(null::${target}, u.row)).* from ${undo} u where u.op <> 'I'`,
    );
    await tx.unsafe(`delete from ${journal} where ${scope}`, params);
    await tx.unsafe(`drop table ${undo}`);
  }
  return undone;
}

/** Drops journal entries at or below a finalised block: those blocks can no longer be reorged. */
export async function pruneJournal(
  tx: TransactionSql,
  schema: string,
  tables: readonly AnyTable[],
  chainId: number,
  throughBlock: number,
): Promise<void> {
  for (const table of tables) {
    await tx.unsafe(
      `delete from ${ident(schema)}.${ident(journalTable(table))} where chain_id = $1 and block_number <= $2`,
      [chainId, throughBlock],
    );
  }
}
