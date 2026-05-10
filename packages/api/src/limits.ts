import {
  type DocumentNode,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";

export interface QueryLimits {
  readonly maxDepth: number;
  /** Fields times the page sizes of the lists that contain them. */
  readonly maxCost: number;
  readonly defaultPageSize: number;
}

/**
 * Estimates a query's depth and cost before running it. Each field costs 1; a field inside a list
 * (any field with a `first` or `last` argument) costs as many times as the list can be long, so
 * nested pages multiply. Rejects with a GraphQLError over either limit.
 */
export function checkLimits(
  document: DocumentNode,
  operationName: string | undefined | null,
  variables: Record<string, unknown> | undefined | null,
  limits: QueryLimits,
): void {
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    if (def.kind === Kind.OPERATION_DEFINITION) operations.push(def);
  }
  const operation =
    operationName == null ? operations[0] : operations.find((o) => o.name?.value === operationName);
  if (operation === undefined) return; // execute() reports this

  const valueOf = (node: ValueNode): unknown => {
    if (node.kind === Kind.INT) return Number(node.value);
    if (node.kind === Kind.VARIABLE) return variables?.[node.name.value];
    return undefined;
  };

  let maxDepth = 0;
  const visit = (set: SelectionSetNode, depth: number, multiplier: number, seen: Set<string>): number => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth > limits.maxDepth) {
      throw new GraphQLError(`query is deeper than ${limits.maxDepth} levels`);
    }
    let cost = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value.startsWith("__")) continue;
        let size = 1;
        for (const arg of selection.arguments ?? []) {
          if (arg.name.value === "first" || arg.name.value === "last") {
            const v = valueOf(arg.value);
            size = typeof v === "number" ? Math.max(v, 1) : limits.defaultPageSize;
          }
        }
        const isList = selection.arguments?.some((a) =>
          ["where", "orderBy", "first", "last", "after", "before"].includes(a.name.value),
        );
        const pageSize =
          isList === true &&
          size === 1 &&
          !selection.arguments?.some((a) => a.name.value === "first" || a.name.value === "last")
            ? limits.defaultPageSize
            : size;
        cost += multiplier;
        if (selection.selectionSet !== undefined) {
          cost += visit(
            selection.selectionSet,
            depth + 1,
            multiplier * (isList === true ? pageSize : 1),
            seen,
          );
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        cost += visit(selection.selectionSet, depth, multiplier, seen);
      } else {
        const name = selection.name.value;
        if (seen.has(name)) throw new GraphQLError(`fragment ${name} spreads itself`);
        const fragment = fragments.get(name);
        if (fragment !== undefined)
          cost += visit(fragment.selectionSet, depth, multiplier, new Set([...seen, name]));
      }
      if (cost > limits.maxCost)
        throw new GraphQLError(`query is too expensive: cost over ${limits.maxCost}`);
    }
    return cost;
  };
  visit(operation.selectionSet, 1, 1, new Set());
}
