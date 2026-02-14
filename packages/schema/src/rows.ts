import { ident } from "@tidemark/pg";
import type { AnyTable, TableColumn } from "./table.js";

export type Row = Record<string, unknown>;

/**
 * Builds a complete row for insertion: applies defaults, checks every value against its column,
 * and refuses unknown keys and missing required values.
 */
export function completeRow(table: AnyTable, input: Row): Row {
  for (const key of Object.keys(input)) {
    if (!(key in table.columns)) throw new TypeError(`${table.name}: unknown column "${key}"`);
  }
  const row: Row = {};
  for (const c of table.columnList) {
    let value = input[c.key];
    if (value === undefined && c.column.defaultValue !== undefined) value = c.column.defaultValue();
    row[c.key] = normalizeValue(table, c, value);
  }
  return row;
}

/** Checks the values in a partial update against their columns. */
export function normalizePatch(table: AnyTable, patch: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const c = table.columnList.find((col) => col.key === key);
    if (c === undefined) throw new TypeError(`${table.name}: unknown column "${key}"`);
    if (table.primaryKey.includes(key))
      throw new TypeError(`${table.name}: primary key column "${key}" cannot be updated`);
    out[key] = normalizeValue(table, c, value);
  }
  return out;
}

function normalizeValue(table: AnyTable, c: TableColumn, value: unknown): unknown {
  const where = `${table.name}.${c.key}`;
  if (value === null || value === undefined) {
    if (c.column.isNotNull) throw new TypeError(`${where}: is not null and has no value`);
    return null;
  }
  return c.column.codec.normalize(value, where);
}

/** Normalises a primary key object and returns it with its cache key. */
export function primaryKeyOf(table: AnyTable, key: Row): { values: Row; text: string } {
  const values: Row = {};
  const parts: string[] = [];
  for (const k of table.primaryKey) {
    const c = table.columnList.find((col) => col.key === k);
    if (c === undefined) throw new Error(`${table.name}: no column ${k}`);
    const raw = key[k];
    if (raw === undefined || raw === null) throw new TypeError(`${table.name}: key is missing "${k}"`);
    const value: unknown = c.column.codec.normalize(raw, `${table.name}.${k}`);
    values[k] = value;
    parts.push(c.column.codec.key(value));
  }
  for (const k of Object.keys(key)) {
    if (!table.primaryKey.includes(k))
      throw new TypeError(`${table.name}: "${k}" is not part of the primary key`);
  }
  return { values, text: parts.length === 1 ? (parts[0] ?? "") : JSON.stringify(parts) };
}

/** A database row (snake_case columns, driver values) back to a TypeScript row. */
export function fromDbRow(table: AnyTable, dbRow: Row): Row {
  const row: Row = {};
  for (const c of table.columnList) {
    const value = dbRow[c.sqlName];
    row[c.key] = value === null || value === undefined ? null : c.column.codec.fromDb(value);
  }
  return row;
}

/** Escapes a value for COPY text format. */
function copyEscape(text: string): string {
  return text.replace(/[\\\n\r\t]/g, (ch) =>
    ch === "\\" ? "\\\\" : ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t",
  );
}

/** A row as one line of COPY text format, columns in table order. */
export function toCopyLine(table: AnyTable, row: Row): string {
  return `${table.columnList
    .map((c) => {
      const value = row[c.key];
      return value === null || value === undefined
        ? "\\N"
        : copyEscape(c.column.codec.toCopy(value as never));
    })
    .join("\t")}\n`;
}

/** `CREATE TABLE` and index DDL for a table in a schema. */
export function tableDdl(table: AnyTable, schema: string): string[] {
  const qualified = `${ident(schema)}.${ident(table.name)}`;
  const columns = table.columnList.map(
    (c) => `${ident(c.sqlName)} ${c.column.codec.sqlType}${c.column.isNotNull ? " not null" : ""}`,
  );
  const pk = table.primaryKey.map((k) => ident(sqlNameOf(table, k))).join(", ");
  const statements = [`create table ${qualified} (\n  ${columns.join(",\n  ")},\n  primary key (${pk})\n)`];
  for (const idx of table.indexes) {
    const cols = idx.columns.map((k) => ident(sqlNameOf(table, k))).join(", ");
    statements.push(
      `create ${idx.unique ? "unique " : ""}index ${ident(idx.name)} on ${qualified} (${cols})`,
    );
  }
  return statements;
}

export function sqlNameOf(table: AnyTable, key: string): string {
  const c = table.columnList.find((col) => col.key === key);
  if (c === undefined) throw new Error(`${table.name}: no column ${key}`);
  return c.sqlName;
}

/** All tables exported by a schema module, in a stable order. */
export function tablesOf(schema: Record<string, unknown>): AnyTable[] {
  const tables = Object.values(schema).filter(
    (v): v is AnyTable => typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "table",
  );
  const names = new Set<string>();
  for (const table of tables) {
    if (names.has(table.name)) throw new Error(`two tables are named ${table.name}`);
    names.add(table.name);
  }
  return tables.sort((a, b) => (a.name < b.name ? -1 : 1));
}
