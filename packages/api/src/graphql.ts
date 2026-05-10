import type { TransactionSql } from "@tidemark/pg";
import { ident } from "@tidemark/pg";
import {
  type AnyTable,
  type ColumnCodec,
  type Relation,
  type Row,
  type TableColumn,
  fromDbRow,
  historyTableName,
} from "@tidemark/schema";
import DataLoader from "dataloader";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLEnumType,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLInputObjectType,
  type GraphQLInputFieldConfigMap,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  type ValueNode,
} from "graphql";

export interface GraphQLLimits {
  /** Rows per page when `first`/`last` is omitted. */
  readonly defaultPageSize: number;
  /** Largest `first` or `last`. */
  readonly maxPageSize: number;
}

/** Where reads go: a schema, and optionally a point in time (a checkpoint). */
export interface Scope {
  readonly schema: string;
  /** Read tables as they were at this checkpoint, from their history. */
  readonly at?: string | undefined;
}

export interface RequestContext extends Scope {
  readonly tx: TransactionSql;
  readonly loaders: Map<string, DataLoader<string, unknown>>;
  readonly limits: GraphQLLimits;
}

const CHECKPOINT_LITERAL = /^\d{0,75}$/;

/**
 * The FROM source for a table: the table itself, or, at a point in time, the versions of its rows
 * that were current then. A table without history cannot be read in the past: that would mix the
 * present into a historical answer.
 */
export function source(scope: Scope, table: AnyTable): string {
  if (scope.at === undefined) return `${ident(scope.schema)}.${ident(table.name)}`;
  if (table.options.history !== true) {
    throw new GraphQLError(`${table.name} keeps no history, so it cannot be read at a past point`);
  }
  if (!CHECKPOINT_LITERAL.test(scope.at)) throw new GraphQLError("bad checkpoint");
  // Digits only (checked), so the literal is safe; a parameter would need threading through every caller.
  return `(select * from ${ident(scope.schema)}.${ident(historyTableName(table.name))} where tm_valid_from <= '${scope.at}' and (tm_valid_to is null or tm_valid_to > '${scope.at}'))`;
}

/** `at:` on history tables' fields: one of these picks the point in time. */
export const AtInput = new GraphQLInputObjectType({
  name: "At",
  description:
    "A point in time for tables with history: a block (with chainId when there are several chains), a unix timestamp, a checkpoint, or the finalised state. One point per request.",
  fields: {
    block: { type: GraphQLString, description: "Block number, as a decimal string or number." },
    chainId: { type: GraphQLInt },
    timestamp: { type: GraphQLInt, description: "Unix seconds." },
    checkpoint: { type: GraphQLString },
    finalized: { type: GraphQLBoolean, description: "The latest state no reorg can change." },
  },
});

// ---------------------------------------------------------------- scalars

const HEX = /^0x([0-9a-fA-F]{2})*$/;

function literal(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return ast.value;
    case Kind.INT:
      return ast.value;
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(literal);
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f) => [f.name.value, literal(f.value)]));
    default:
      return undefined;
  }
}

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (
    (typeof value === "string" && /^-?\d+$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return BigInt(value);
  }
  throw new TypeError(`BigInt must be an integer or a string of digits, got ${JSON.stringify(value)}`);
};

export const BigIntScalar = new GraphQLScalarType({
  name: "BigInt",
  description: "An integer of any size, sent as a string of decimal digits.",
  coerceOutputValue: (value) => toBigInt(value).toString(),
  coerceInputValue: toBigInt,
  coerceInputLiteral: (ast) => toBigInt(literal(ast)),
});

const toHex = (value: unknown): string => {
  if (typeof value !== "string" || !HEX.test(value)) throw new TypeError(`Hex must be even-length 0x hex`);
  return value.toLowerCase();
};

export const HexScalar = new GraphQLScalarType({
  name: "Hex",
  description: "Bytes as lowercase 0x-prefixed hex.",
  coerceOutputValue: toHex,
  coerceInputValue: toHex,
  coerceInputLiteral: (ast) => toHex(literal(ast)),
});

const toDate = (value: unknown): Date => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? new Date(Number(value) * 1000)
        : typeof value === "string" || typeof value === "number"
          ? new Date(typeof value === "number" ? value * 1000 : value)
          : undefined;
  if (date === undefined || Number.isNaN(date.getTime()))
    throw new TypeError("Timestamp must be ISO 8601 or unix seconds");
  return date;
};

export const TimestampScalar = new GraphQLScalarType({
  name: "Timestamp",
  description: "A point in time: ISO 8601 out; ISO 8601 or unix seconds in.",
  coerceOutputValue: (value) => toDate(value).toISOString(),
  coerceInputValue: toDate,
  coerceInputLiteral: (ast) => toDate(literal(ast)),
});

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  coerceOutputValue: (value) => value,
  coerceInputValue: (value) => value,
  coerceInputLiteral: literal,
});

const scalarFor: Record<string, GraphQLScalarType> = {
  Hex: HexScalar,
  String: GraphQLString,
  BigInt: BigIntScalar,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  Timestamp: TimestampScalar,
  JSON: JSONScalar,
};

const ORDERED_OPS = ["eq", "ne", "in", "notIn", "gt", "gte", "lt", "lte", "isNull"] as const;
const opsFor: Record<string, readonly string[]> = {
  Hex: ORDERED_OPS,
  BigInt: ORDERED_OPS,
  Int: ORDERED_OPS,
  Float: ORDERED_OPS,
  Timestamp: ORDERED_OPS,
  String: [...ORDERED_OPS, "contains", "startsWith", "endsWith"],
  Boolean: ["eq", "ne", "isNull"],
  JSON: ["isNull"],
};

const filterInputs = new Map<string, GraphQLInputObjectType>();
function columnFilter(apiType: string): GraphQLInputObjectType {
  const existing = filterInputs.get(apiType);
  if (existing !== undefined) return existing;
  const scalar = scalarFor[apiType] ?? GraphQLString;
  const fields: GraphQLInputFieldConfigMap = {};
  for (const op of opsFor[apiType] ?? ["eq"]) {
    fields[op] = {
      type:
        op === "in" || op === "notIn"
          ? new GraphQLList(new GraphQLNonNull(scalar))
          : op === "isNull"
            ? GraphQLBoolean
            : scalar,
    };
  }
  const input = new GraphQLInputObjectType({ name: `${apiType}Filter`, fields });
  filterInputs.set(apiType, input);
  return input;
}

const OrderDirection = new GraphQLEnumType({
  name: "OrderDirection",
  values: { ASC: { value: "ASC" }, DESC: { value: "DESC" } },
});

const PageInfo = new GraphQLObjectType({
  name: "PageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    startCursor: { type: GraphQLString },
    endCursor: { type: GraphQLString },
  },
});

// ---------------------------------------------------------------- naming

const pascal = (name: string) => name.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
const camel = (name: string) => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

// ---------------------------------------------------------------- SQL building

class Params {
  readonly values: unknown[] = [];
  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return `$${this.values.length}${cast === undefined ? "" : `::${cast}`}`;
  }
}

const baseType = (c: TableColumn) => c.column.codec.sqlType.replace(/\(.*\)$/, "");

/** A value from a cursor or a batch key (JSON) back into the column's canonical value. */
function fromJsonValue(c: TableColumn, value: unknown): unknown {
  const codec = c.column.codec as ColumnCodec<unknown>;
  if (value === null) return null;
  const raw =
    codec.name === "bigint"
      ? BigInt(value as string)
      : codec.name === "timestamp"
        ? new Date(value as string)
        : value;
  return codec.normalize(raw, c.key);
}

function param(params: Params, c: TableColumn, value: unknown): string {
  const normalized: unknown = c.column.codec.normalize(value, c.key);
  return params.add(c.column.codec.toParam(normalized as never), c.column.codec.sqlType);
}

function arrayParam(params: Params, c: TableColumn, values: readonly unknown[]): string {
  const converted = values.map((v) => c.column.codec.toParam(c.column.codec.normalize(v, c.key) as never));
  return params.add(converted, `${baseType(c)}[]`);
}

export interface Filter {
  readonly AND?: readonly Filter[];
  readonly OR?: readonly Filter[];
  readonly NOT?: Filter;
  readonly [key: string]: unknown;
}

interface Built {
  readonly table: AnyTable;
  readonly relations: Readonly<Record<string, Relation>>;
}

let aliasCounter = 0;

function whereSql(
  built: Map<string, Built>,
  table: AnyTable,
  filter: Filter | null | undefined,
  alias: string,
  params: Params,
  scope: Scope,
): string {
  if (filter === null || filter === undefined) return "true";
  const parts: string[] = [];
  const relations = built.get(table.name)?.relations ?? {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR") {
      const list = (value as Filter[]).map((f) => `(${whereSql(built, table, f, alias, params, scope)})`);
      if (list.length > 0) parts.push(`(${list.join(key === "AND" ? " and " : " or ")})`);
      else if (key === "OR") parts.push("false");
      continue;
    }
    if (key === "NOT") {
      parts.push(`not (${whereSql(built, table, value as Filter, alias, params, scope)})`);
      continue;
    }
    const relation = relations[key];
    if (relation !== undefined) {
      const sub = `r${++aliasCounter}`;
      const join = relation.fields
        .map(
          (f, i) =>
            `${sub}.${ident(sqlName(relation.target, relation.references[i] ?? ""))} = ${alias}.${ident(sqlName(table, f))}`,
        )
        .join(" and ");
      const target = source(scope, relation.target);
      if (relation.kind === "one") {
        const inner = whereSql(built, relation.target, value as Filter, sub, params, scope);
        parts.push(`exists (select 1 from ${target} ${sub} where ${join} and (${inner}))`);
      } else {
        const ops = value as { some?: Filter; none?: Filter; every?: Filter };
        if (ops.some !== undefined) {
          parts.push(
            `exists (select 1 from ${target} ${sub} where ${join} and (${whereSql(built, relation.target, ops.some, sub, params, scope)}))`,
          );
        }
        if (ops.none !== undefined) {
          parts.push(
            `not exists (select 1 from ${target} ${sub} where ${join} and (${whereSql(built, relation.target, ops.none, sub, params, scope)}))`,
          );
        }
        if (ops.every !== undefined) {
          parts.push(
            `not exists (select 1 from ${target} ${sub} where ${join} and not (${whereSql(built, relation.target, ops.every, sub, params, scope)}))`,
          );
        }
      }
      continue;
    }
    const c = table.columnList.find((col) => col.key === key);
    if (c === undefined) throw new Error(`unknown filter field ${key}`);
    const col = `${alias}.${ident(c.sqlName)}`;
    for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
      if (operand === undefined) continue;
      if (operand === null && op !== "isNull") {
        parts.push(op === "ne" ? `${col} is not null` : op === "eq" ? `${col} is null` : "false");
        continue;
      }
      switch (op) {
        case "eq":
          parts.push(`${col} = ${param(params, c, operand)}`);
          break;
        case "ne":
          parts.push(`${col} is distinct from ${param(params, c, operand)}`);
          break;
        case "gt":
          parts.push(`${col} > ${param(params, c, operand)}`);
          break;
        case "gte":
          parts.push(`${col} >= ${param(params, c, operand)}`);
          break;
        case "lt":
          parts.push(`${col} < ${param(params, c, operand)}`);
          break;
        case "lte":
          parts.push(`${col} <= ${param(params, c, operand)}`);
          break;
        case "in":
          parts.push(`${col} = any(${arrayParam(params, c, operand as unknown[])})`);
          break;
        case "notIn":
          parts.push(`not (${col} = any(${arrayParam(params, c, operand as unknown[])}))`);
          break;
        case "isNull":
          parts.push(operand === true ? `${col} is null` : `${col} is not null`);
          break;
        case "contains":
          parts.push(`strpos(${col}, ${params.add(operand, "text")}) > 0`);
          break;
        case "startsWith":
          parts.push(`starts_with(${col}, ${params.add(operand, "text")})`);
          break;
        case "endsWith":
          parts.push(
            `right(${col}, char_length(${params.add(operand, "text")})) = ${params.add(operand, "text")}`,
          );
          break;
        default:
          throw new Error(`unknown operator ${op}`);
      }
    }
  }
  return parts.length === 0 ? "true" : parts.join(" and ");
}

function sqlName(table: AnyTable, key: string): string {
  const c = table.columnList.find((col) => col.key === key);
  if (c === undefined) throw new Error(`${table.name} has no column ${key}`);
  return c.sqlName;
}

interface OrderTerm {
  readonly column: TableColumn;
  readonly desc: boolean;
}

/** The requested order, with the primary key appended so the order is total. */
function orderTerms(
  table: AnyTable,
  orderBy: readonly Record<string, string>[] | null | undefined,
): OrderTerm[] {
  const terms: OrderTerm[] = [];
  for (const entry of orderBy ?? []) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) throw new Error("each orderBy entry must name exactly one column");
    const key = keys[0] as string;
    const column = table.columnList.find((c) => c.key === key);
    if (column === undefined) throw new Error(`cannot order by ${key}`);
    if (!terms.some((t) => t.column.key === key)) terms.push({ column, desc: entry[key] === "DESC" });
  }
  for (const pk of table.primaryKey) {
    if (!terms.some((t) => t.column.key === pk)) {
      const column = table.columnList.find((c) => c.key === pk) as TableColumn;
      terms.push({ column, desc: false });
    }
  }
  return terms;
}

const orderSql = (terms: readonly OrderTerm[], alias: string, reverse = false) =>
  terms.map((t) => `${alias}.${ident(t.column.sqlName)} ${t.desc !== reverse ? "desc" : "asc"}`).join(", ");

// Cursors: the order-by values of a row, as JSON, base64url. Opaque to clients.
function encodeCursor(terms: readonly OrderTerm[], row: Row): string {
  const values = terms.map((t) => {
    const v = row[t.column.key];
    return v === null || v === undefined
      ? null
      : typeof v === "bigint"
        ? v.toString()
        : v instanceof Date
          ? v.toISOString()
          : v;
  });
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function decodeCursor(terms: readonly OrderTerm[], cursor: string): unknown[] {
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (!Array.isArray(values) || values.length !== terms.length)
    throw new Error("cursor does not match this ordering");
  return values.map((v, i) => fromJsonValue((terms[i] as OrderTerm).column, v));
}

/**
 * Rows strictly after (or before) a cursor in the given order. Postgres sorts nulls last ascending
 * and first descending, and the comparison follows the same rule, so nullable columns page correctly.
 */
function keysetSql(
  terms: readonly OrderTerm[],
  values: readonly unknown[],
  alias: string,
  params: Params,
  before: boolean,
): string {
  const ors: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    const ands: string[] = [];
    for (let j = 0; j < i; j++) {
      const t = terms[j] as OrderTerm;
      const col = `${alias}.${ident(t.column.sqlName)}`;
      const v = values[j];
      ands.push(
        v === null
          ? `${col} is null`
          : `${col} = ${params.add(t.column.column.codec.toParam(v as never), t.column.column.codec.sqlType)}`,
      );
    }
    const t = terms[i] as OrderTerm;
    const col = `${alias}.${ident(t.column.sqlName)}`;
    const v = values[i];
    const p = () => params.add(t.column.column.codec.toParam(v as never), t.column.column.codec.sqlType);
    // Postgres orders nulls last ascending and first descending. "After" in an ascending order, or
    // "before" in a descending one, means bigger values or nulls; otherwise smaller values only.
    const towardNulls = t.desc === before;
    const cmp = towardNulls
      ? v === null
        ? "false"
        : `(${col} > ${p()} or ${col} is null)`
      : v === null
        ? `${col} is not null`
        : `${col} < ${p()}`;
    ands.push(cmp);
    ors.push(`(${ands.join(" and ")})`);
  }
  return `(${ors.join(" or ")})`;
}

export interface ConnectionArgs {
  readonly where?: Filter | null;
  readonly orderBy?: readonly Record<string, string>[] | null;
  readonly first?: number | null;
  readonly after?: string | null;
  readonly last?: number | null;
  readonly before?: string | null;
}

interface Connection {
  readonly nodes: Row[];
  readonly edges: { cursor: string; node: Row }[];
  readonly pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  readonly totalCount: () => Promise<number>;
}

function pageSize(args: ConnectionArgs, limits: GraphQLLimits): { size: number; backward: boolean } {
  if (args.first != null && args.last != null) throw new Error("use either first or last, not both");
  const backward = args.last != null || (args.before != null && args.first == null);
  const size = (backward ? args.last : args.first) ?? limits.defaultPageSize;
  if (!Number.isInteger(size) || size < 0 || size > limits.maxPageSize) {
    throw new Error(`page size must be between 0 and ${limits.maxPageSize}`);
  }
  return { size, backward };
}

function connectionFrom(
  rows: Row[],
  terms: readonly OrderTerm[],
  size: number,
  backward: boolean,
  args: ConnectionArgs,
  count: () => Promise<number>,
): Connection {
  const more = rows.length > size;
  const page = rows.slice(0, size);
  if (backward) page.reverse();
  const edges = page.map((node) => ({ cursor: encodeCursor(terms, node), node }));
  return {
    nodes: page,
    edges,
    pageInfo: {
      hasNextPage: backward ? args.before != null : more,
      hasPreviousPage: backward ? more : args.after != null,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount: count,
  };
}

async function fetchConnection(
  ctx: RequestContext,
  built: Map<string, Built>,
  table: AnyTable,
  args: ConnectionArgs,
  extraWhere?: (alias: string, params: Params) => string,
): Promise<Connection> {
  const { size, backward } = pageSize(args, ctx.limits);
  const terms = orderTerms(table, args.orderBy);
  const params = new Params();
  const alias = "t";
  const conditions = [whereSql(built, table, args.where, alias, params, ctx)];
  if (extraWhere !== undefined) conditions.push(extraWhere(alias, params));
  const countConditions = [...conditions];
  const countParams = [...params.values];
  if (args.after != null)
    conditions.push(keysetSql(terms, decodeCursor(terms, args.after), alias, params, false));
  if (args.before != null)
    conditions.push(keysetSql(terms, decodeCursor(terms, args.before), alias, params, true));
  const from = `${source(ctx, table)} ${alias}`;
  const rows = await ctx.tx.unsafe(
    `select ${alias}.* from ${from} where ${conditions.join(" and ")} order by ${orderSql(terms, alias, backward)} limit ${size + 1}`,
    params.values as never[],
  );
  const count = async () => {
    const [row] = await ctx.tx.unsafe<{ n: bigint }[]>(
      `select count(*)::int8 as n from ${from} where ${countConditions.join(" and ")}`,
      countParams as never[],
    );
    return Number(row?.n ?? 0);
  };
  return connectionFrom(
    rows.map((r) => fromDbRow(table, r)),
    terms,
    size,
    backward,
    args,
    count,
  );
}

// ---------------------------------------------------------------- schema

export interface BuildOptions {
  readonly tables: readonly AnyTable[];
  readonly relations: ReadonlyMap<string, Readonly<Record<string, Relation>>>;
}

/** Builds the GraphQL schema for a set of tables and their relations. */
export function buildGraphQLSchema(options: BuildOptions): GraphQLSchema {
  const built = new Map<string, Built>(
    options.tables.map((table) => [
      table.name,
      { table, relations: options.relations.get(table.name) ?? {} },
    ]),
  );
  for (const { table, relations } of built.values()) {
    for (const [name, relation] of Object.entries(relations)) {
      if (!built.has(relation.target.name))
        throw new Error(`${table.name}.${name}: target ${relation.target.name} is not in the schema`);
    }
  }

  const objects = new Map<string, GraphQLObjectType>();
  const filters = new Map<string, GraphQLInputObjectType>();
  const orders = new Map<string, GraphQLInputObjectType>();
  const connections = new Map<string, GraphQLObjectType>();

  const filterFor = (table: AnyTable): GraphQLInputObjectType => {
    const existing = filters.get(table.name);
    if (existing !== undefined) return existing;
    const name = pascal(table.name);
    const input: GraphQLInputObjectType = new GraphQLInputObjectType({
      name: `${name}Filter`,
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {
          AND: { type: new GraphQLList(new GraphQLNonNull(input)) },
          OR: { type: new GraphQLList(new GraphQLNonNull(input)) },
          NOT: { type: input },
        };
        for (const c of table.columnList) fields[c.key] = { type: columnFilter(c.column.codec.apiType) };
        for (const [rel, relation] of Object.entries(built.get(table.name)?.relations ?? {})) {
          const targetFilter = filterFor(relation.target);
          fields[rel] =
            relation.kind === "one"
              ? { type: targetFilter }
              : {
                  type: new GraphQLInputObjectType({
                    name: `${name}${pascal(rel)}RelationFilter`,
                    fields: {
                      some: { type: targetFilter },
                      none: { type: targetFilter },
                      every: { type: targetFilter },
                    },
                  }),
                };
        }
        return fields;
      },
    });
    filters.set(table.name, input);
    return input;
  };

  const orderFor = (table: AnyTable): GraphQLInputObjectType => {
    const existing = orders.get(table.name);
    if (existing !== undefined) return existing;
    const input = new GraphQLInputObjectType({
      name: `${pascal(table.name)}OrderBy`,
      fields: Object.fromEntries(table.columnList.map((c) => [c.key, { type: OrderDirection }])),
    });
    orders.set(table.name, input);
    return input;
  };

  const connectionArgs = (table: AnyTable) => ({
    where: { type: filterFor(table) },
    orderBy: { type: new GraphQLList(new GraphQLNonNull(orderFor(table))) },
    first: { type: GraphQLInt },
    after: { type: GraphQLString },
    last: { type: GraphQLInt },
    before: { type: GraphQLString },
  });

  const objectFor = (table: AnyTable): GraphQLObjectType => {
    const existing = objects.get(table.name);
    if (existing !== undefined) return existing;
    const object: GraphQLObjectType = new GraphQLObjectType({
      name: pascal(table.name),
      fields: () => {
        const fields: GraphQLFieldConfigMap<Row, RequestContext> = {};
        for (const c of table.columnList) {
          const scalar = scalarFor[c.column.codec.apiType] ?? GraphQLString;
          fields[c.key] = { type: c.column.isNotNull ? new GraphQLNonNull(scalar) : scalar };
        }
        for (const [rel, relation] of Object.entries(built.get(table.name)?.relations ?? {})) {
          if (relation.kind === "one") {
            fields[rel] = {
              type: objectFor(relation.target),
              resolve: (row, _args, ctx) => loadOne(ctx, table, rel, relation, row),
            };
          } else {
            fields[rel] = {
              type: new GraphQLNonNull(connectionFor(relation.target)),
              args: connectionArgs(relation.target),
              resolve: (row, args: ConnectionArgs, ctx) =>
                loadMany(ctx, built, table, rel, relation, row, args),
            };
          }
        }
        return fields;
      },
    });
    objects.set(table.name, object);
    return object;
  };

  const connectionFor = (table: AnyTable): GraphQLObjectType => {
    const existing = connections.get(table.name);
    if (existing !== undefined) return existing;
    const node = new GraphQLNonNull(objectFor(table));
    const connection = new GraphQLObjectType<Connection, RequestContext>({
      name: `${pascal(table.name)}Connection`,
      fields: {
        nodes: { type: new GraphQLNonNull(new GraphQLList(node)) },
        edges: {
          type: new GraphQLNonNull(
            new GraphQLList(
              new GraphQLNonNull(
                new GraphQLObjectType({
                  name: `${pascal(table.name)}Edge`,
                  fields: { cursor: { type: new GraphQLNonNull(GraphQLString) }, node: { type: node } },
                }),
              ),
            ),
          ),
        },
        pageInfo: { type: new GraphQLNonNull(PageInfo) },
        totalCount: { type: new GraphQLNonNull(GraphQLInt), resolve: (c) => c.totalCount() },
      },
    });
    connections.set(table.name, connection);
    return connection;
  };

  const ChainStatus = new GraphQLObjectType({
    name: "ChainStatus",
    fields: {
      chainId: { type: new GraphQLNonNull(GraphQLInt) },
      blockNumber: { type: new GraphQLNonNull(BigIntScalar) },
      finalizedBlock: { type: new GraphQLNonNull(BigIntScalar) },
      checkpoint: { type: new GraphQLNonNull(GraphQLString) },
      updatedAt: { type: new GraphQLNonNull(TimestampScalar) },
    },
  });
  const Meta = new GraphQLObjectType({
    name: "Meta",
    fields: { chains: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ChainStatus))) } },
  });

  const queryFields: GraphQLFieldConfigMap<unknown, RequestContext> = {
    _meta: {
      type: new GraphQLNonNull(Meta),
      resolve: async (_root, _args, ctx) => {
        const rows = await ctx.tx.unsafe<
          {
            chain_id: bigint;
            block_number: bigint;
            finalized_block: bigint;
            checkpoint: string;
            updated_at: Date;
          }[]
        >(
          `select chain_id, block_number, finalized_block, checkpoint, updated_at from ${ident(ctx.schema)}."_tm_checkpoints" order by chain_id`,
        );
        return {
          chains: rows.map((r) => ({
            chainId: Number(r.chain_id),
            blockNumber: r.block_number,
            finalizedBlock: r.finalized_block,
            checkpoint: r.checkpoint,
            updatedAt: r.updated_at,
          })),
        };
      },
    },
  };

  for (const table of options.tables) {
    const one = camel(table.name);
    let many = plural(one);
    if (many === one) many = `${one}List`;
    const pkArgs = Object.fromEntries(
      table.primaryKey.map((k) => {
        const c = table.columnList.find((col) => col.key === k) as TableColumn;
        return [k, { type: new GraphQLNonNull(scalarFor[c.column.codec.apiType] ?? GraphQLString) }];
      }),
    );
    const atArg = table.options.history === true ? { at: { type: AtInput } } : {};
    queryFields[one] = {
      type: objectFor(table) as GraphQLOutputType,
      args: { ...pkArgs, ...atArg },
      resolve: async (_root, args: Record<string, unknown>, ctx) => {
        const params = new Params();
        const where = table.primaryKey
          .map((k) => {
            const c = table.columnList.find((col) => col.key === k) as TableColumn;
            return `t.${ident(c.sqlName)} = ${param(params, c, args[k])}`;
          })
          .join(" and ");
        const [row] = await ctx.tx.unsafe(
          `select t.* from ${source(ctx, table)} t where ${where}`,
          params.values as never[],
        );
        return row === undefined ? null : fromDbRow(table, row);
      },
    };
    queryFields[many] = {
      type: new GraphQLNonNull(connectionFor(table)),
      args: { ...connectionArgs(table), ...atArg },
      resolve: (_root, args: ConnectionArgs, ctx) => fetchConnection(ctx, built, table, args),
    };
  }

  return new GraphQLSchema({ query: new GraphQLObjectType({ name: "Query", fields: queryFields }) });
}

// ---------------------------------------------------------------- relation loading

function keyOf(values: readonly unknown[]): string {
  return JSON.stringify(values, (_, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v,
  );
}

function loader<V>(
  ctx: RequestContext,
  id: string,
  batch: (keys: readonly string[]) => Promise<V[]>,
): DataLoader<string, V> {
  let existing = ctx.loaders.get(id) as DataLoader<string, V> | undefined;
  if (existing === undefined) {
    existing = new DataLoader<string, V>(batch);
    ctx.loaders.set(id, existing as DataLoader<string, unknown>);
  }
  return existing;
}

/** `(a, b) in (select * from unnest($1, $2))` for a batch of composite keys. */
function inKeys(
  table: AnyTable,
  columns: readonly string[],
  alias: string,
  params: Params,
  values: unknown[][],
): string {
  const cols = columns.map((k) => table.columnList.find((c) => c.key === k) as TableColumn);
  const arrays = cols.map((c, i) =>
    params.add(
      values.map((v) => c.column.codec.toParam(v[i] as never)),
      `${baseType(c)}[]`,
    ),
  );
  return `(${cols.map((c) => `${alias}.${ident(c.sqlName)}`).join(", ")}) in (select * from unnest(${arrays.join(", ")}))`;
}

async function loadOne(
  ctx: RequestContext,
  table: AnyTable,
  rel: string,
  relation: Relation,
  row: Row,
): Promise<Row | null> {
  const values = relation.fields.map((f) => row[f]);
  if (values.some((v) => v === null || v === undefined)) return null;
  const target = relation.target;
  const load = loader<Row | null>(ctx, `one:${table.name}.${rel}`, async (keys) => {
    const parsed = keys.map((k) => JSON.parse(k) as unknown[]);
    const decoded = parsed.map((vals) =>
      vals.map((v, i) =>
        fromJsonValue(target.columnList.find((col) => col.key === relation.references[i]) as TableColumn, v),
      ),
    );
    const params = new Params();
    const rows = await ctx.tx.unsafe(
      `select t.* from ${source(ctx, target)} t where ${inKeys(target, relation.references, "t", params, decoded)}`,
      params.values as never[],
    );
    const byKey = new Map(
      rows.map((r) => {
        const node = fromDbRow(target, r);
        return [keyOf(relation.references.map((k) => node[k])), node] as const;
      }),
    );
    return keys.map((k) => byKey.get(k) ?? null);
  });
  return load.load(keyOf(values));
}

async function loadMany(
  ctx: RequestContext,
  built: Map<string, Built>,
  table: AnyTable,
  rel: string,
  relation: Relation,
  row: Row,
  args: ConnectionArgs,
): Promise<Connection> {
  const target = relation.target;
  const values = relation.fields.map((f) => row[f]);
  const refColumns = relation.references.map(
    (k) => target.columnList.find((c) => c.key === k) as TableColumn,
  );
  const parentFilter = (alias: string, params: Params) =>
    refColumns
      .map((c, i) =>
        values[i] === null || values[i] === undefined
          ? "false"
          : `${alias}.${ident(c.sqlName)} = ${params.add(c.column.codec.toParam(values[i] as never), c.column.codec.sqlType)}`,
      )
      .join(" and ");

  // Cursors are per parent, so a paged request is answered on its own.
  if (args.after != null || args.before != null || args.last != null) {
    return fetchConnection(ctx, built, target, args, parentFilter);
  }

  const { size } = pageSize(args, ctx.limits);
  const terms = orderTerms(target, args.orderBy);
  const load = loader<Row[]>(
    ctx,
    `many:${table.name}.${rel}:${JSON.stringify([args.where, args.orderBy, size])}`,
    async (keys) => {
      const decoded = keys.map((k) =>
        (JSON.parse(k) as unknown[]).map((v, i) => fromJsonValue(refColumns[i] as TableColumn, v)),
      );
      const params = new Params();
      // One LATERAL subquery per parent key: each walks an index on the reference columns and
      // stops after the page, instead of sorting every child of every parent.
      const arrays = refColumns.map((c, i) =>
        params.add(
          decoded.map((v) => c.column.codec.toParam(v[i] as never)),
          `${baseType(c)}[]`,
        ),
      );
      const keyCols = refColumns.map((_, i) => `k${i}`);
      const where = whereSql(built, target, args.where, "t", params, ctx);
      const match = refColumns.map((c, i) => `t.${ident(c.sqlName)} = k.k${i}`).join(" and ");
      const rows = await ctx.tx.unsafe(
        `select x.* from unnest(${arrays.join(", ")}) with ordinality as k(${keyCols.join(", ")}, "_tm_ord")
       cross join lateral (
         select t.* from ${source(ctx, target)} t
         where ${match} and ${where}
         order by ${orderSql(terms, "t")} limit ${size + 1}
       ) x
       order by k."_tm_ord", ${orderSql(terms, "x")}`,
        params.values as never[],
      );
      const grouped = new Map<string, Row[]>(keys.map((k) => [k, []]));
      for (const r of rows) {
        const node = fromDbRow(target, r);
        grouped.get(keyOf(relation.references.map((k) => node[k])))?.push(node);
      }
      return keys.map((k) => grouped.get(k) ?? []);
    },
  );
  const hasKey = !values.some((v) => v === null || v === undefined);
  const rows = hasKey ? await load.load(keyOf(values)) : [];
  // Counts for every parent in one grouped query, only if some query asks for totalCount.
  const count = async () => {
    if (!hasKey) return 0;
    const counter = loader<number>(
      ctx,
      `count:${table.name}.${rel}:${JSON.stringify(args.where)}`,
      async (keys) => {
        const decoded = keys.map((k) =>
          (JSON.parse(k) as unknown[]).map((v, i) => fromJsonValue(refColumns[i] as TableColumn, v)),
        );
        const params = new Params();
        const where = whereSql(built, target, args.where, "t", params, ctx);
        const group = refColumns.map((c) => `t.${ident(c.sqlName)}`).join(", ");
        const counted = await ctx.tx.unsafe(
          `select ${group}, count(*)::int8 as "_tm_n" from ${source(ctx, target)} t
         where ${inKeys(target, relation.references, "t", params, decoded)} and ${where} group by ${group}`,
          params.values as never[],
        );
        const byKey = new Map(
          counted.map((r) => {
            const node = fromDbRow(target, r);
            return [keyOf(relation.references.map((k) => node[k])), Number(r._tm_n as bigint)] as const;
          }),
        );
        return keys.map((k) => byKey.get(k) ?? 0);
      },
    );
    return counter.load(keyOf(values));
  };
  return connectionFrom(rows, terms, size, false, args, count);
}
