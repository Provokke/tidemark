import { metrics } from "@tidemark/core";
import { type Sql, type TransactionSql, ident } from "@tidemark/pg";
import { type AnyTable, relationsOf, tablesOf } from "@tidemark/schema";
import {
  type DocumentNode,
  type FieldNode,
  GraphQLError,
  Kind,
  type SelectionSetNode,
  type ValueNode,
  getOperationAST,
  type GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
  TypeInfo,
  type ValidationRule,
  execute,
  getNamedType,
  parse,
  printSchema,
  specifiedRules,
  validate,
  visit,
  visitWithTypeInfo,
} from "graphql";
import { type RequestContext, buildGraphQLSchema } from "./graphql.js";
import { checkLimits } from "./limits.js";
import type { ApiLimits } from "./server.js";
import { SqlRejectedError, guardSelect } from "./sql-guard.js";
import { toJsonValue } from "./values.js";

const sqlRejected = metrics.counter("tm_sql_rejected_total", "SQL endpoint queries the guard refused.");

/** What the API serves: one build's tables, in one Postgres schema. Swapped whole on cutover. */
export interface Target {
  readonly graphqlSchema: GraphQLSchema;
  readonly sdl: string;
  readonly tableNames: ReadonlySet<string>;
  /** GraphQL type name to the table whose rows it returns (node, connection and edge types). */
  readonly typeTables: ReadonlyMap<string, string>;
  /** Functions the SQL endpoint may call beyond the built-in allowlist: time travel, when tables keep history. */
  readonly functions: ReadonlySet<string>;
  readonly schemaName: string;
  readonly buildId: string | undefined;
}

const pascal = (name: string) => name.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

export function makeTarget(schema: Record<string, unknown>, schemaName: string, buildId?: string): Target {
  const tables: readonly AnyTable[] = tablesOf(schema);
  const graphqlSchema = buildGraphQLSchema({ tables, relations: relationsOf(schema) });
  const typeTables = new Map<string, string>();
  for (const t of tables) {
    for (const suffix of ["", "Connection", "Edge"]) typeTables.set(`${pascal(t.name)}${suffix}`, t.name);
  }
  const history = tables.filter((t) => t.options.history === true).map((t) => `${t.name}_at`);
  const functions = new Set(
    history.length === 0
      ? []
      : [...history, "tm_checkpoint_at", "tm_timestamp_checkpoint", "tm_finalized_checkpoint"],
  );
  return {
    graphqlSchema,
    sdl: printSchema(graphqlSchema),
    tableNames: new Set(tables.map((t) => t.name)),
    typeTables,
    functions,
    schemaName,
    buildId,
  };
}

/** An HTTP-shaped result: what a route returns, and what a live query pushes. */
export interface Outcome {
  readonly status: number;
  readonly body: unknown;
}

/** A query checked and ready to run, any number of times, against its target. */
export interface Prepared {
  readonly target: Target;
  /** Tables whose changes can change the result; "all" when it reads `_meta`. */
  readonly tables: ReadonlySet<string> | "all";
  run(): Promise<Outcome>;
}

export interface GraphQLInput {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

export interface SqlInput {
  readonly query?: unknown;
  readonly params?: unknown;
}

export function validationRules(introspection: boolean): ValidationRule[] {
  return introspection ? [...specifiedRules] : [...specifiedRules, NoSchemaIntrospectionCustomRule];
}

/** The tables a GraphQL document reads, from the types of the fields it selects. */
function graphqlTables(target: Target, document: DocumentNode): ReadonlySet<string> | "all" {
  const tables = new Set<string>();
  const found = { all: false };
  const typeInfo = new TypeInfo(target.graphqlSchema);
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field() {
        const type = typeInfo.getType();
        if (type === null || type === undefined) return;
        const name = getNamedType(type).name;
        if (name === "Meta") found.all = true;
        const table = target.typeTables.get(name);
        if (table !== undefined) tables.add(table);
      },
    }),
  );
  return found.all ? "all" : tables;
}

type AtValue = Readonly<Record<string, unknown>>;

/** A literal argument as a plain value, with variables (also nested in objects) filled in. */
function literalValue(node: ValueNode, variables: Record<string, unknown> | undefined): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      return variables?.[node.name.value];
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((f) => [f.name.value, literalValue(f.value, variables)]));
    case Kind.LIST:
      return node.values.map((v) => literalValue(v, variables));
    case Kind.INT:
      return Number(node.value);
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
  }
}

/**
 * The `at` of a request: every root field that has one must agree, so the whole response is one
 * point in time (fields without `at` follow it too).
 */
function collectAt(
  document: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown> | undefined,
): AtValue | undefined | Error {
  const operation = getOperationAST(document, operationName);
  if (operation === null || operation === undefined) return undefined;
  const fragments = new Map(
    document.definitions.flatMap((d) =>
      d.kind === Kind.FRAGMENT_DEFINITION ? [[d.name.value, d] as const] : [],
    ),
  );
  const found = new Map<string, AtValue>();
  const visitSet = (set: SelectionSetNode, seen: Set<string>) => {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const arg = (selection as FieldNode).arguments?.find((a) => a.name.value === "at");
        if (arg === undefined) continue;
        const value = literalValue(arg.value, variables);
        if (typeof value === "object" && value !== null) found.set(JSON.stringify(value), value as AtValue);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        visitSet(selection.selectionSet, seen);
      } else {
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (fragment !== undefined && !seen.has(name))
          visitSet(fragment.selectionSet, new Set([...seen, name]));
      }
    }
  };
  visitSet(operation.selectionSet, new Set());
  if (found.size > 1) return new Error("every field in a request must use the same `at`");
  return [...found.values()][0];
}

/** Turns an `at` into a checkpoint, with the build schema's time-travel functions. */
async function resolveAt(tx: TransactionSql, schema: string, at: AtValue): Promise<string> {
  const s = ident(schema);
  const chosen = ["block", "timestamp", "checkpoint", "finalized"].filter(
    (k) => at[k] !== undefined && at[k] !== null,
  );
  if (chosen.length !== 1)
    throw new GraphQLError("`at` needs exactly one of block, timestamp, checkpoint or finalized");
  if (at.finalized === true) {
    const [row] = await tx.unsafe<{ c: string }[]>(`select ${s}.tm_finalized_checkpoint() as c`);
    return row?.c ?? "";
  }
  if (at.finalized === false)
    throw new GraphQLError("`at: { finalized: false }` means nothing; leave `at` out");
  if (typeof at.checkpoint === "string") {
    if (!/^\d{75}$/.test(at.checkpoint)) throw new GraphQLError("a checkpoint is 75 digits");
    return at.checkpoint;
  }
  if (typeof at.timestamp === "number") {
    const [row] = await tx.unsafe<{ c: string }[]>(`select ${s}.tm_timestamp_checkpoint($1) as c`, [
      at.timestamp,
    ]);
    return row?.c ?? "";
  }
  const block = String(at.block);
  if (!/^\d{1,19}$/.test(block)) throw new GraphQLError("`at.block` must be a block number");
  let chainId = typeof at.chainId === "number" ? at.chainId : undefined;
  if (chainId === undefined) {
    const chains = await tx.unsafe<{ chain_id: bigint }[]>(`select chain_id from ${s}."_tm_checkpoints"`);
    if (chains.length !== 1)
      throw new GraphQLError("this build indexes several chains: give `at.chainId` with `at.block`");
    chainId = Number(chains[0]?.chain_id);
  }
  const [row] = await tx.unsafe<{ c: string }[]>(`select ${s}.tm_checkpoint_at($1, $2) as c`, [
    chainId,
    block,
  ]);
  return row?.c ?? "";
}

export function prepareGraphQL(
  sql: Sql,
  target: Target,
  limits: ApiLimits,
  rules: readonly ValidationRule[],
  input: GraphQLInput,
): Prepared | Outcome {
  if (typeof input.query !== "string")
    return { status: 400, body: { errors: [{ message: "query must be a string" }] } };
  const variables = (
    typeof input.variables === "object" && input.variables !== null ? input.variables : undefined
  ) as Record<string, unknown> | undefined;
  const operationName = typeof input.operationName === "string" ? input.operationName : undefined;
  let document: DocumentNode;
  try {
    document = parse(input.query);
  } catch (error) {
    return { status: 400, body: { errors: [{ message: (error as Error).message }] } };
  }
  const validation = validate(target.graphqlSchema, document, rules);
  if (validation.length > 0)
    return { status: 400, body: { errors: validation.map((e) => ({ message: e.message })) } };
  try {
    checkLimits(document, operationName, variables, limits);
  } catch (error) {
    return { status: 400, body: { errors: [{ message: (error as GraphQLError).message }] } };
  }
  const at = collectAt(document, operationName, variables);
  if (at instanceof Error) return { status: 400, body: { errors: [{ message: at.message }] } };
  return {
    target,
    tables: graphqlTables(target, document),
    async run() {
      // One read-only snapshot for the whole query, so every nested read agrees.
      let atCheckpoint: string | undefined;
      let badAt: GraphQLError | undefined;
      const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
        await tx.unsafe(`set local statement_timeout = ${Math.floor(limits.statementTimeoutMs)}`);
        if (at !== undefined) {
          try {
            atCheckpoint = await resolveAt(tx, target.schemaName, at);
          } catch (error) {
            if (!(error instanceof GraphQLError)) throw error;
            badAt = error;
            return undefined;
          }
        }
        const ctx: RequestContext = {
          tx,
          schema: target.schemaName,
          loaders: new Map(),
          limits,
          at: atCheckpoint,
        };
        return execute({
          schema: target.graphqlSchema,
          document,
          variableValues: variables,
          operationName,
          contextValue: ctx,
        });
      });
      if (badAt !== undefined || result === undefined) {
        return { status: 400, body: { errors: [{ message: badAt?.message ?? "bad `at`" }] } };
      }
      const errors = result.errors?.map((e) => ({ message: e.message, path: e.path }));
      return {
        status: 200,
        body: { data: result.data ?? null, ...(errors === undefined ? {} : { errors }) },
      };
    },
  };
}

export async function prepareSql(
  sql: Sql,
  target: Target,
  limits: ApiLimits,
  input: SqlInput,
): Promise<Prepared | Outcome> {
  if (typeof input.query !== "string") return { status: 400, body: { error: "query must be a string" } };
  const params = Array.isArray(input.params) ? (input.params as unknown[]) : [];
  if (params.some((p) => p !== null && !["string", "number", "boolean"].includes(typeof p))) {
    return { status: 400, body: { error: "params must be strings, numbers, booleans or null" } };
  }
  let tables: Set<string>;
  try {
    ({ tables } = await guardSelect(input.query, {
      schema: target.schemaName,
      tables: target.tableNames,
      functions: target.functions,
    }));
  } catch (error) {
    if (error instanceof SqlRejectedError) {
      sqlRejected.inc();
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
  const query = input.query;
  return {
    target,
    tables,
    async run() {
      try {
        const out = await sql.begin("read only", async (tx) => {
          await tx.unsafe(`set local statement_timeout = ${Math.floor(limits.statementTimeoutMs)}`);
          await tx.unsafe(`set local search_path = ${ident(target.schemaName)}`);
          await tx.unsafe("set local work_mem = '16MB'");
          const rows: unknown[][] = [];
          let columns: { name: string; type: number }[] = [];
          let truncated = false;
          for await (const batch of tx.unsafe(query, params as never[]).cursor(500)) {
            const meta = (batch as unknown as { columns?: { name: string; type: number }[] }).columns;
            if (meta !== undefined && columns.length === 0)
              columns = meta.map((m) => ({ name: m.name, type: m.type }));
            for (const row of batch as Record<string, unknown>[]) {
              if (rows.length >= limits.sqlMaxRows) {
                truncated = true;
                break;
              }
              rows.push(columns.map((col) => toJsonValue(row[col.name])));
            }
            if (truncated) break;
          }
          return { columns, rows, truncated };
        });
        return { status: 200, body: out };
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

export const isOutcome = (x: Prepared | Outcome): x is Outcome => "status" in x;

export { GraphQLError };
