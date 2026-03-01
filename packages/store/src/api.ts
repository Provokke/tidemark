import type { AnyTable, InferInsert, InferKey, InferSelect, Row } from "@tidemark/schema";

/** What a patch may set for each column: the insert type, minus the primary key. */
type PatchValues<T extends AnyTable> = Partial<Omit<InferInsert<T>, T["primaryKey"][number]>>;

/** A handler broke a store rule. Deterministic: re-running the same event fails the same way. */
export class StoreError extends Error {
  override name = "StoreError";
}

export class UniqueConstraintError extends StoreError {
  override name = "UniqueConstraintError";
}

export class RecordNotFoundError extends StoreError {
  override name = "RecordNotFoundError";
}

export type Patch<T extends AnyTable> = PatchValues<T>;
export type PatchArg<T extends AnyTable> = Patch<T> | ((row: InferSelect<T>) => Patch<T>);

/** What every store implements, untyped. The typed `Db` wraps it. */
export interface StoreBackend {
  find(table: AnyTable, key: Row): Promise<Row | null>;
  /** Inserts a row; `onConflict` decides what happens when the key exists. */
  insert(
    table: AnyTable,
    row: Row,
    onConflict: "error" | "nothing" | { update: Row | ((existing: Row) => Row) },
  ): Promise<void>;
  update(table: AnyTable, key: Row, patch: Row | ((existing: Row) => Row)): Promise<Row>;
  delete(table: AnyTable, key: Row): Promise<boolean>;
}

class InsertValues<T extends AnyTable> implements PromiseLike<void> {
  readonly #backend: StoreBackend;
  readonly #table: T;
  readonly #rows: readonly Row[];

  constructor(backend: StoreBackend, table: T, rows: readonly Row[]) {
    this.#backend = backend;
    this.#table = table;
    this.#rows = rows;
  }

  async #run(onConflict: Parameters<StoreBackend["insert"]>[2]): Promise<void> {
    for (const row of this.#rows) await this.#backend.insert(this.#table, row, onConflict);
  }

  /** Inserts, and throws `UniqueConstraintError` if a row with the same key exists. */
  then<A = void, B = never>(
    // PromiseLike<void> requires this parameter type.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    onfulfilled?: ((value: void) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.#run("error").then(onfulfilled, onrejected);
  }

  /** Inserts, leaving an existing row with the same key as it is. */
  onConflictDoNothing(): Promise<void> {
    return this.#run("nothing");
  }

  /** Inserts, or updates the existing row with the same key. */
  onConflictDoUpdate(patch: PatchArg<T>): Promise<void> {
    return this.#run({ update: patch as Row | ((existing: Row) => Row) });
  }
}

/** The database API handlers get as `context.db`. */
export class Db {
  readonly #backend: StoreBackend;

  constructor(backend: StoreBackend) {
    this.#backend = backend;
  }

  async find<T extends AnyTable>(table: T, key: InferKey<T>): Promise<InferSelect<T> | null> {
    return (await this.#backend.find(table, key as Row)) as InferSelect<T> | null;
  }

  insert<T extends AnyTable>(table: T) {
    return {
      values: (rows: InferInsert<T> | readonly InferInsert<T>[]) =>
        new InsertValues(this.#backend, table, (Array.isArray(rows) ? rows : [rows]) as Row[]),
    };
  }

  update<T extends AnyTable>(table: T, key: InferKey<T>) {
    return {
      set: async (patch: PatchArg<T>): Promise<InferSelect<T>> =>
        (await this.#backend.update(
          table,
          key as Row,
          patch as Row | ((existing: Row) => Row),
        )) as InferSelect<T>,
    };
  }

  /** Deletes the row with this key. Returns whether one existed. */
  delete<T extends AnyTable>(table: T, key: InferKey<T>): Promise<boolean> {
    return this.#backend.delete(table, key as Row);
  }
}
