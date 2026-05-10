import { parse } from "libpg-query";

/** A query the SQL endpoint will not run. `reason` is safe to show to the caller. */
export class SqlRejectedError extends Error {
  override name = "SqlRejectedError";
}

/**
 * Functions a query may call. Everything else is refused, which keeps out `pg_sleep`, `set_config`,
 * `current_setting`, `pg_read_file`, `dblink`, large objects, advisory locks and the like. Long or
 * heavy queries made of allowed functions are bounded by the statement timeout.
 */
const ALLOWED_FUNCTIONS = new Set(
  `count sum avg min max bool_and bool_or every array_agg string_agg json_agg jsonb_agg json_object_agg
   jsonb_object_agg stddev stddev_pop stddev_samp variance var_pop var_samp percentile_cont percentile_disc mode
   row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
   abs ceil ceiling floor round trunc mod power sqrt exp ln log log10 sign div width_bucket
   lower upper length char_length octet_length substr substring left right concat concat_ws replace trim btrim
   ltrim rtrim lpad rpad position strpos split_part starts_with encode decode to_hex reverse initcap
   now date_trunc date_part extract to_timestamp to_char age make_interval timezone date_bin
   jsonb_extract_path jsonb_extract_path_text json_extract_path json_extract_path_text jsonb_array_length
   jsonb_typeof jsonb_build_object json_build_object jsonb_build_array json_build_array to_jsonb to_json
   jsonb_array_elements jsonb_array_elements_text jsonb_each jsonb_each_text jsonb_object_keys
   array_length cardinality unnest array_position array_to_string array_remove array_append
   generate_series num_nonnulls num_nulls`
    .split(/\s+/)
    .filter((s) => s !== ""),
);

/** Casting to these exposes catalogue objects by name. */
const REFUSED_TYPES = /^reg/;

type Node = Record<string, unknown>;

export interface GuardOptions {
  /** The schema queries read from. A table may be named with it or unqualified. */
  readonly schema: string;
  /** Tables that may be read. */
  readonly tables: ReadonlySet<string>;
  /** Functions in the readable schema that may be called too (time travel: `<table>_at`). */
  readonly functions?: ReadonlySet<string>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => {
    const s = (v as { String?: { sval?: string } }).String?.sval;
    return typeof s === "string" ? s : "";
  });
}

/**
 * Parses `query` with Postgres's own parser and refuses anything but a single, read-only `SELECT`
 * over the allowed tables, calling only allowed functions. Throws `SqlRejectedError`.
 */
export async function guardSelect(query: string, options: GuardOptions): Promise<{ tables: Set<string> }> {
  let tree: { stmts?: { stmt: Node }[] };
  try {
    tree = (await parse(query)) as typeof tree;
  } catch (error) {
    throw new SqlRejectedError(`syntax error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const statements = tree.stmts ?? [];
  if (statements.length !== 1) throw new SqlRejectedError("exactly one statement is allowed");
  const [only] = statements;
  const kind = only === undefined ? undefined : Object.keys(only.stmt)[0];
  if (kind !== "SelectStmt") throw new SqlRejectedError(`only SELECT is allowed, got ${kind ?? "nothing"}`);

  const cteNames = new Set<string>();
  collectCtes(only?.stmt, cteNames);
  const tables = new Set<string>();
  walk(only?.stmt, options, cteNames, tables);
  return { tables };
}

function collectCtes(node: unknown, names: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCtes(item, names);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Node)) {
    if (key === "CommonTableExpr") {
      const name = (value as { ctename?: unknown }).ctename;
      if (typeof name === "string") names.add(name);
    }
    collectCtes(value, names);
  }
}

function walk(node: unknown, options: GuardOptions, ctes: ReadonlySet<string>, seen: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, options, ctes, seen);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Node)) {
    // Any statement other than SELECT, anywhere (a data-modifying CTE included), is refused.
    if (key.endsWith("Stmt") && key !== "SelectStmt") throw new SqlRejectedError(`${key} is not allowed`);
    switch (key) {
      case "SelectStmt": {
        const select = value as Node;
        if (Array.isArray(select.lockingClause) && select.lockingClause.length > 0) {
          throw new SqlRejectedError("row locking (FOR UPDATE / FOR SHARE) is not allowed");
        }
        if (select.intoClause !== undefined) throw new SqlRejectedError("SELECT INTO is not allowed");
        break;
      }
      case "RangeVar": {
        const rv = value as { catalogname?: string; schemaname?: string; relname?: string };
        if (rv.catalogname !== undefined)
          throw new SqlRejectedError("cross-database references are not allowed");
        const name = rv.relname ?? "";
        if (rv.schemaname === undefined && ctes.has(name)) break;
        if (rv.schemaname !== undefined && rv.schemaname !== options.schema) {
          throw new SqlRejectedError(`schema ${rv.schemaname} is not readable`);
        }
        if (!options.tables.has(name)) throw new SqlRejectedError(`table ${name} is not readable`);
        seen.add(name);
        break;
      }
      case "FuncCall": {
        const names = stringList((value as { funcname?: unknown }).funcname);
        const fn = (names[names.length - 1] ?? "").toLowerCase();
        const schema = names.length > 1 ? names[0] : undefined;
        const own =
          (schema === undefined || schema === options.schema) && options.functions?.has(fn) === true;
        if (own) {
          // `<table>_at(...)` reads `<table>`, for live queries' dependencies.
          if (fn.endsWith("_at") && options.tables.has(fn.slice(0, -3))) seen.add(fn.slice(0, -3));
          break;
        }
        if ((schema !== undefined && schema !== "pg_catalog") || !ALLOWED_FUNCTIONS.has(fn)) {
          throw new SqlRejectedError(`function ${names.join(".")} is not allowed`);
        }
        break;
      }
      // A type appears as a TypeName node or, in casts, under a `typeName` property.
      case "TypeName":
      case "typeName": {
        const names = stringList((value as { names?: unknown }).names);
        const type = (names[names.length - 1] ?? "").toLowerCase();
        if (REFUSED_TYPES.test(type)) throw new SqlRejectedError(`type ${type} is not allowed`);
        break;
      }
      case "RangeTableSample":
      case "RangeTableFunc":
        throw new SqlRejectedError(`${key} is not allowed`);
      default:
        break;
    }
    walk(value, options, ctes, seen);
  }
}
