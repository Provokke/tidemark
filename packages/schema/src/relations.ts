import type { AnyTable } from "./table.js";

/**
 * A relation from one table to another by matching columns: `fields` on this table equal
 * `references` on the target. `one` expects at most one target row; `many` any number.
 */
export interface Relation {
  readonly kind: "one" | "many";
  readonly target: AnyTable;
  readonly fields: readonly string[];
  readonly references: readonly string[];
}

export interface Relations<T extends AnyTable = AnyTable> {
  readonly kind: "relations";
  readonly table: T;
  readonly relations: Readonly<Record<string, Relation>>;
}

interface RelationArgs {
  readonly fields: readonly string[];
  readonly references: readonly string[];
}

const helpers = {
  one: (target: AnyTable, args: RelationArgs): Relation => ({ kind: "one", target, ...args }),
  many: (target: AnyTable, args: RelationArgs): Relation => ({ kind: "many", target, ...args }),
};

/**
 * Declares relations for the API. For example, a pool's swaps and a swap's pool:
 *
 *     relations(pool, ({ many }) => ({ swaps: many(swap, { fields: ["id"], references: ["pool"] }) }))
 *     relations(swap, ({ one }) => ({ pool: one(pool, { fields: ["pool"], references: ["id"] }) }))
 */
export function relations<T extends AnyTable>(
  table: T,
  define: (h: typeof helpers) => Record<string, Relation>,
): Relations<T> {
  const defined = define(helpers);
  for (const [name, relation] of Object.entries(defined)) {
    if (name in table.columns)
      throw new Error(`${table.name}: relation ${name} has the same name as a column`);
    if (relation.fields.length === 0 || relation.fields.length !== relation.references.length) {
      throw new Error(`${table.name}.${name}: fields and references must be non-empty and the same length`);
    }
    for (const f of relation.fields) {
      if (!(f in table.columns)) throw new Error(`${table.name}.${name}: no column ${f}`);
    }
    for (const r of relation.references) {
      if (!(r in relation.target.columns))
        throw new Error(`${table.name}.${name}: ${relation.target.name} has no column ${r}`);
    }
  }
  return { kind: "relations", table, relations: defined };
}

/** Every relation declared in a schema module, by table name. */
export function relationsOf(
  schema: Record<string, unknown>,
): Map<string, Readonly<Record<string, Relation>>> {
  const out = new Map<string, Record<string, Relation>>();
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "relations")
      continue;
    const r = value as Relations;
    const existing = out.get(r.table.name) ?? {};
    for (const [name, relation] of Object.entries(r.relations)) {
      if (name in existing) throw new Error(`${r.table.name}: relation ${name} is declared twice`);
      existing[name] = relation;
    }
    out.set(r.table.name, existing);
  }
  return out;
}
