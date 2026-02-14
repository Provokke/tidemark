import type { AnyColumn, Column } from "./columns.js";

const SQL_NAME = /^[a-z][a-z0-9_]{0,49}$/;

/**
 * A column key in camelCase (as handlers and the API see it) to its SQL name in snake_case.
 * `sqrtPriceX96` becomes `sqrt_price_x96`; `tokenURI` becomes `token_uri`.
 */
export function toSqlName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export interface ColumnRef {
  readonly key: string;
}

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

interface IndexBuilder {
  on(...columns: ColumnRef[]): {
    readonly kind: "index";
    readonly columns: readonly string[];
    readonly unique: boolean;
  };
}

export const index = (): IndexBuilder => ({
  on: (...columns) => ({ kind: "index", columns: columns.map((c) => c.key), unique: false }),
});

export const uniqueIndex = (): IndexBuilder => ({
  on: (...columns) => ({ kind: "index", columns: columns.map((c) => c.key), unique: true }),
});

export const primaryKey = (args: { columns: ColumnRef[] }) => ({
  kind: "primaryKey" as const,
  columns: args.columns.map((c) => c.key),
});

type Extra = ReturnType<IndexBuilder["on"]> | ReturnType<typeof primaryKey>;

export interface TableOptions {
  /** Keep every version of every row, for time-travel queries. */
  readonly history?: boolean;
}

export interface TableColumn {
  readonly key: string;
  readonly sqlName: string;
  readonly column: AnyColumn;
}

export interface Table<
  TName extends string = string,
  TColumns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
> {
  readonly kind: "table";
  readonly name: TName;
  readonly columns: TColumns;
  readonly columnList: readonly TableColumn[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexDef[];
  readonly options: TableOptions;
}

export type AnyTable = Table;

const internalTables = new Set<string>();

/**
 * A table Tidemark itself keeps in a build's schema (the outbox, for one). Its name starts with
 * `_tm_`, which user tables cannot, so the two never collide.
 */
export function internalTable<TName extends `_tm_${string}`, TColumns extends Record<string, AnyColumn>>(
  name: TName,
  columns: TColumns,
  extra?: (columns: { [K in keyof TColumns]: ColumnRef }) => Record<string, Extra>,
): Table<TName, TColumns> {
  internalTables.add(name);
  return onchainTable(name, columns, extra);
}

/** Defines a table of indexed data. Exactly one primary key: a column's `.primaryKey()` or `primaryKey()`. */
export function onchainTable<TName extends string, TColumns extends Record<string, AnyColumn>>(
  name: TName,
  columns: TColumns,
  extra?: (columns: { [K in keyof TColumns]: ColumnRef }) => Record<string, Extra>,
  options: TableOptions = {},
): Table<TName, TColumns> {
  if (!SQL_NAME.test(name) && !(internalTables.has(name) && /^_tm_[a-z0-9_]{1,59}$/.test(name))) {
    throw new Error(
      `table name "${name}" must be lowercase snake_case, start with a letter, at most 50 characters`,
    );
  }
  const columnList: TableColumn[] = Object.entries(columns).map(([key, column]) => {
    const sqlName = toSqlName(key);
    if (!SQL_NAME.test(sqlName))
      throw new Error(`table ${name}: column "${key}" does not make a valid SQL name`);
    return { key, sqlName, column };
  });
  if (columnList.length === 0) throw new Error(`table ${name} has no columns`);
  const seen = new Map<string, string>();
  for (const c of columnList) {
    const other = seen.get(c.sqlName);
    if (other !== undefined)
      throw new Error(`table ${name}: columns "${other}" and "${c.key}" both map to ${c.sqlName}`);
    seen.set(c.sqlName, c.key);
  }

  const refs = Object.fromEntries(columnList.map((c) => [c.key, { key: c.key }])) as {
    [K in keyof TColumns]: ColumnRef;
  };
  const extras = Object.entries(extra?.(refs) ?? {});

  const columnPks = columnList.filter((c) => c.column.isPrimaryKey).map((c) => c.key);
  const tablePks = extras.filter(([, e]) => e.kind === "primaryKey").map(([, e]) => e.columns);
  if (columnPks.length > 1) throw new Error(`table ${name}: use primaryKey({ columns }) for a composite key`);
  if (columnPks.length + tablePks.length !== 1)
    throw new Error(`table ${name} needs exactly one primary key`);
  const pk = columnPks.length === 1 ? columnPks : (tablePks[0] ?? []);
  for (const key of pk) {
    const column = columns[key];
    if (column === undefined) throw new Error(`table ${name}: primary key column ${key} does not exist`);
  }

  const indexes: IndexDef[] = extras
    .filter((e): e is [string, ReturnType<IndexBuilder["on"]>] => e[1].kind === "index")
    .map(([indexKey, def]) => {
      if (def.columns.length === 0) throw new Error(`table ${name}: index ${indexKey} has no columns`);
      return { name: `${name}_${toSqlName(indexKey)}`, columns: def.columns, unique: def.unique };
    });

  return { kind: "table", name, columns, columnList, primaryKey: pk, indexes, options };
}

type ColumnValue<C> =
  C extends Column<infer T, infer N, boolean, boolean, unknown> ? (N extends true ? T : T | null) : never;
type ColumnInput<C> =
  C extends Column<unknown, infer N, boolean, boolean, infer I> ? (N extends true ? I : I | null) : never;
type IsRequired<C> =
  C extends Column<unknown, infer N, infer D, boolean, unknown>
    ? N extends true
      ? D extends true
        ? false
        : true
      : false
    : false;

/** A row as read back: every column, nullable ones as `T | null`. */
export type InferSelect<TTable extends AnyTable> = {
  [K in keyof TTable["columns"]]: ColumnValue<TTable["columns"][K]>;
};

/** A row to insert: not-null columns without a default are required; the rest are optional. */
export type InferInsert<TTable extends AnyTable> = {
  [K in keyof TTable["columns"] as IsRequired<TTable["columns"][K]> extends true ? K : never]: ColumnInput<
    TTable["columns"][K]
  >;
} & {
  [K in keyof TTable["columns"] as IsRequired<TTable["columns"][K]> extends true ? never : K]?: ColumnInput<
    TTable["columns"][K]
  >;
};

/** The primary key columns of a table. */
export type InferKey<TTable extends AnyTable> = Partial<InferSelect<TTable>>;
