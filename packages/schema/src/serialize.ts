import {
  type AnyColumn,
  Column,
  type ColumnCodec,
  bigintCodec,
  booleanCodec,
  hexCodec,
  integerCodec,
  jsonCodec,
  realCodec,
  textCodec,
  timestampCodec,
} from "./columns.js";
import type { Relation, Relations } from "./relations.js";
import { type AnyTable, type TableOptions, index, onchainTable, primaryKey, uniqueIndex } from "./table.js";

/**
 * Table and relation definitions as plain JSON, stored with each build so a process without the
 * project's code (the API) can rebuild them: same names, types, keys, indexes and relations.
 */
export interface SerializedSchema {
  readonly version: 1;
  readonly tables: readonly SerializedTable[];
  readonly relations: readonly SerializedRelation[];
}

export interface SerializedTable {
  readonly name: string;
  readonly columns: readonly { readonly key: string; readonly type: string; readonly notNull: boolean }[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly unique: boolean;
  }[];
  readonly options: TableOptions;
}

export interface SerializedRelation {
  readonly table: string;
  readonly name: string;
  readonly kind: "one" | "many";
  readonly target: string;
  readonly fields: readonly string[];
  readonly references: readonly string[];
}

const codecs: Record<string, ColumnCodec<unknown>> = Object.fromEntries(
  [hexCodec, textCodec, bigintCodec, integerCodec, realCodec, booleanCodec, timestampCodec, jsonCodec].map(
    (c) => [c.name, c as ColumnCodec<unknown>],
  ),
);

export function serializeSchema(
  tables: readonly AnyTable[],
  relations: ReadonlyMap<string, Readonly<Record<string, Relation>>>,
): SerializedSchema {
  return {
    version: 1,
    tables: tables.map((table) => ({
      name: table.name,
      columns: table.columnList.map((c) => ({
        key: c.key,
        type: c.column.codec.name,
        notNull: c.column.isNotNull,
      })),
      primaryKey: [...table.primaryKey],
      indexes: table.indexes.map((i) => ({ name: i.name, columns: [...i.columns], unique: i.unique })),
      options: table.options,
    })),
    relations: [...relations].flatMap(([table, defs]) =>
      Object.entries(defs).map(([name, r]) => ({
        table,
        name,
        kind: r.kind,
        target: r.target.name,
        fields: [...r.fields],
        references: [...r.references],
      })),
    ),
  };
}

/** Rebuilds a schema module (tables and relations) from its serialised form. */
export function deserializeSchema(serialized: SerializedSchema): Record<string, unknown> {
  if ((serialized.version as number) !== 1)
    throw new Error(`unknown serialised schema version ${String(serialized.version)}`);
  const tables = new Map<string, AnyTable>();
  for (const t of serialized.tables) {
    const columns: Record<string, AnyColumn> = {};
    for (const c of t.columns) {
      const codec = codecs[c.type];
      if (codec === undefined) throw new Error(`table ${t.name}: unknown column type ${c.type}`);
      const single = t.primaryKey.length === 1 && t.primaryKey[0] === c.key;
      let column: AnyColumn = new Column(codec);
      if (single) column = column.primaryKey();
      else if (c.notNull) column = column.notNull();
      columns[c.key] = column;
    }
    const prefix = `${t.name}_`;
    const table = onchainTable(
      t.name,
      columns,
      (refs) => {
        const extras: Record<string, unknown> = {};
        if (t.primaryKey.length > 1) {
          extras.pk = primaryKey({ columns: t.primaryKey.map((k) => refs[k] as { key: string }) });
        }
        for (const i of t.indexes) {
          // The stored name is "<table>_<key>"; the key is what onchainTable expects back.
          const key = i.name.startsWith(prefix) ? i.name.slice(prefix.length) : i.name;
          extras[key] = (i.unique ? uniqueIndex() : index()).on(
            ...i.columns.map((c) => refs[c] as { key: string }),
          );
        }
        return extras as never;
      },
      t.options,
    );
    tables.set(t.name, table);
  }
  const module: Record<string, unknown> = Object.fromEntries(tables);
  const byTable = new Map<string, Record<string, Relation>>();
  for (const r of serialized.relations) {
    const target = tables.get(r.target);
    if (target === undefined || !tables.has(r.table))
      throw new Error(`relation ${r.table}.${r.name}: unknown table`);
    const defs = byTable.get(r.table) ?? {};
    defs[r.name] = { kind: r.kind, target, fields: r.fields, references: r.references };
    byTable.set(r.table, defs);
  }
  for (const [name, defs] of byTable) {
    const relationsValue: Relations = {
      kind: "relations",
      table: tables.get(name) as AnyTable,
      relations: defs,
    };
    module[`${name}Relations`] = relationsValue;
  }
  return module;
}
