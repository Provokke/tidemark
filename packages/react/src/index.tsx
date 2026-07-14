import {
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { LiveMeta, LiveOptions, LiveQuery, SqlResult, TidemarkClient } from "@tidemark/client";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";

const ClientContext = createContext<TidemarkClient<Record<string, unknown>> | undefined>(undefined);

/** Makes a Tidemark client available to the hooks below it. Put it inside a `QueryClientProvider`. */
export function TidemarkProvider<S extends Record<string, unknown>>(props: {
  readonly client: TidemarkClient<S>;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <ClientContext.Provider value={props.client as TidemarkClient<Record<string, unknown>>}>
      {props.children}
    </ClientContext.Provider>
  );
}

/** The client from the nearest `TidemarkProvider`. */
export function useTidemarkClient<
  S extends Record<string, unknown> = Record<string, unknown>,
>(): TidemarkClient<S> {
  const client = useContext(ClientContext);
  if (client === undefined)
    throw new Error("useTidemarkClient: wrap your app in <TidemarkProvider client={...}>");
  return client as TidemarkClient<S>;
}

/** A stable cache key for a query, the same on every render for the same query. */
export function liveQueryKey(query: LiveQuery): QueryKey {
  const json = (value: unknown) =>
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
  if ("graphql" in query) return ["tidemark", "graphql", query.graphql, json(query.variables ?? null)];
  if ("sql" in query) return ["tidemark", "sql", query.sql, json(query.params ?? [])];
  const compiled = query.compile();
  return ["tidemark", "sql", compiled.sql, json(compiled.parameters)];
}

async function fetchOnce(
  client: TidemarkClient<Record<string, unknown>>,
  query: LiveQuery,
): Promise<unknown> {
  if ("graphql" in query) return client.graphql(query.graphql, query.variables);
  const result: SqlResult =
    "sql" in query
      ? await client.sql(query.sql, query.params)
      : await (({ sql, parameters }) => client.sql(sql, parameters))(query.compile());
  return result.rows;
}

/**
 * A one-off query through TanStack Query: a query builder, raw SQL or GraphQL, cached by its text
 * and parameters. Builder and SQL results are decoded rows; GraphQL is `data`.
 */
export function useTidemarkQuery<T = unknown>(
  query: LiveQuery,
  options: Omit<UseQueryOptions<T>, "queryKey" | "queryFn"> = {},
): UseQueryResult<T> {
  const client = useTidemarkClient();
  const key = liveQueryKey(query);
  return useQuery<T>({ ...options, queryKey: key, queryFn: () => fetchOnce(client, query) as Promise<T> });
}

export interface UseLiveQueryResult<T> extends Omit<UseQueryResult<T>, "error"> {
  readonly error: Error | null;
  /** The build that produced the current data, once a live result has arrived. */
  readonly build: string | null;
}

/**
 * A live query: fetched like `useTidemarkQuery`, then kept current. The API pushes a new result
 * whenever a commit changes it (and after a reorg or a cutover), and the hook writes it into the
 * TanStack Query cache, so every component using the same query re-renders with it.
 */
export function useLiveQuery<T = unknown>(
  query: LiveQuery,
  options: Omit<UseQueryOptions<T>, "queryKey" | "queryFn"> &
    LiveOptions & { readonly enabled?: boolean } = {},
): UseLiveQueryResult<T> {
  const client = useTidemarkClient();
  const queryClient = useQueryClient();
  const key = liveQueryKey(query);
  const keyText = JSON.stringify(key);
  const [build, setBuild] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<Error | null>(null);
  const { transport, maxBackoffMs, onError, ...queryOptions } = options;
  const result = useQuery<T>({
    ...queryOptions,
    queryKey: key,
    queryFn: () => fetchOnce(client, query) as Promise<T>,
    // Pushes keep it fresh; refetching on focus or mount would only repeat them.
    staleTime: Number.POSITIVE_INFINITY,
  });
  // The query object may be rebuilt every render; its key is what identifies it.
  const stableQuery = useMemo(() => query, [keyText]);
  useEffect(() => {
    if (options.enabled === false) return undefined;
    return client.live<T>(
      stableQuery,
      (data: T, meta: LiveMeta) => {
        queryClient.setQueryData<T>(key, data);
        setBuild(meta.build);
        setLiveError(null);
      },
      {
        ...(transport === undefined ? {} : { transport }),
        ...(maxBackoffMs === undefined ? {} : { maxBackoffMs }),
        onError: (error) => {
          setLiveError(error);
          onError?.(error);
        },
      },
    );
  }, [client, queryClient, keyText, transport, maxBackoffMs, options.enabled]);
  return { ...result, error: liveError ?? result.error, build } as UseLiveQueryResult<T>;
}
