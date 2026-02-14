import { bytesToHex, hexToBytes } from "@tidemark/pg";

export type Hex = `0x${string}`;

/**
 * How one column type is stored and moved: its Postgres type, how a handler's value is checked and
 * made canonical, how it is sent as a query parameter, how it is written in COPY text format, and
 * how a value read back from Postgres becomes a TypeScript value again.
 */
export interface ColumnCodec<T> {
  readonly name: string;
  readonly sqlType: string;
  /** Checks a value and returns its canonical form (lowercase hex, a Date for timestamps). */
  normalize(value: unknown, where: string): T;
  /** A query parameter for the postgres driver. */
  toParam(value: T): unknown;
  /** The value in COPY text format, before escaping (escaping is done by the store). */
  toCopy(value: T): string;
  /** A value from the driver back into its TypeScript form. */
  fromDb(value: unknown): T;
  /** Text that is equal for equal values; used to key rows by primary key. */
  key(value: T): string;
  /** The scalar type the API exposes. */
  readonly apiType: "Hex" | "String" | "BigInt" | "Int" | "Float" | "Boolean" | "Timestamp" | "JSON";
}

const fail = (where: string, expected: string, value: unknown): never => {
  const shown = typeof value === "bigint" ? `${value}n` : (JSON.stringify(value) as string | undefined);
  throw new TypeError(
    `${where}: expected ${expected}, got ${shown === undefined ? typeof value : shown.slice(0, 80)}`,
  );
};

const HEX = /^0x([0-9a-fA-F]{2})*$/;

export const hexCodec: ColumnCodec<Hex> = {
  name: "hex",
  sqlType: "bytea",
  normalize(value, where) {
    if (typeof value !== "string" || !HEX.test(value)) return fail(where, "even-length 0x hex", value);
    return value.toLowerCase() as Hex;
  },
  toParam: (value) => hexToBytes(value),
  toCopy: (value) => `\\x${value.slice(2)}`,
  fromDb: (value) => bytesToHex(value as Uint8Array),
  key: (value) => value,
  apiType: "Hex",
};

export const textCodec: ColumnCodec<string> = {
  name: "text",
  sqlType: "text",
  normalize(value, where) {
    if (typeof value !== "string") return fail(where, "a string", value);
    if (value.includes("\0")) return fail(where, "a string without NUL characters", value);
    return value;
  },
  toParam: (value) => value,
  toCopy: (value) => value,
  fromDb: (value) => value as string,
  key: (value) => value,
  apiType: "String",
};

const UINT256_DIGITS = 78;
const BIGINT_LIMIT = 10n ** BigInt(UINT256_DIGITS);

export const bigintCodec: ColumnCodec<bigint> = {
  name: "bigint",
  sqlType: `numeric(${UINT256_DIGITS},0)`,
  normalize(value, where) {
    if (typeof value !== "bigint") return fail(where, "a bigint", value);
    if (value >= BIGINT_LIMIT || value <= -BIGINT_LIMIT)
      return fail(where, `a bigint of at most ${UINT256_DIGITS} digits`, value);
    return value;
  },
  toParam: (value) => value.toString(),
  toCopy: (value) => value.toString(),
  fromDb: (value) => BigInt(value as string),
  key: (value) => value.toString(),
  apiType: "BigInt",
};

export const integerCodec: ColumnCodec<number> = {
  name: "integer",
  sqlType: "integer",
  normalize(value, where) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) {
      return fail(where, "a 32-bit integer", value);
    }
    return value;
  },
  toParam: (value) => value,
  toCopy: (value) => String(value),
  fromDb: (value) => Number(value),
  key: (value) => String(value),
  apiType: "Int",
};

export const realCodec: ColumnCodec<number> = {
  name: "real",
  sqlType: "double precision",
  normalize(value, where) {
    if (typeof value !== "number") return fail(where, "a number", value);
    return value;
  },
  toParam: (value) => value,
  toCopy: (value) =>
    Number.isNaN(value)
      ? "NaN"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : String(value),
  fromDb: (value) => Number(value),
  key: (value) => String(value),
  apiType: "Float",
};

export const booleanCodec: ColumnCodec<boolean> = {
  name: "boolean",
  sqlType: "boolean",
  normalize(value, where) {
    if (typeof value !== "boolean") return fail(where, "a boolean", value);
    return value;
  },
  toParam: (value) => value,
  toCopy: (value) => (value ? "t" : "f"),
  fromDb: (value) => value as boolean,
  key: (value) => (value ? "t" : "f"),
  apiType: "Boolean",
};

/**
 * A point in time. Accepts a Date, or a block timestamp in seconds as a bigint or a number, so
 * `event.block.timestamp` can be stored as it is. Reads back as a Date.
 */
export const timestampCodec: ColumnCodec<Date> = {
  name: "timestamp",
  sqlType: "timestamptz",
  normalize(value, where) {
    const date =
      value instanceof Date
        ? new Date(value.getTime())
        : typeof value === "bigint" || typeof value === "number"
          ? new Date(Number(value) * 1_000)
          : undefined;
    if (date === undefined || Number.isNaN(date.getTime()))
      return fail(where, "a Date or unix seconds", value);
    return date;
  },
  toParam: (value) => value,
  toCopy: (value) => value.toISOString(),
  fromDb: (value) => new Date(value as Date),
  key: (value) => String(value.getTime()),
  apiType: "Timestamp",
};

export const jsonCodec: ColumnCodec<unknown> = {
  name: "json",
  sqlType: "jsonb",
  normalize(value, where) {
    try {
      const text = JSON.stringify(value) as string | undefined;
      if (text === undefined) return fail(where, "a JSON value", value);
      return JSON.parse(text) as unknown;
    } catch {
      return fail(where, "a JSON-serialisable value (bigints are not)", value);
    }
  },
  toParam: (value) => JSON.stringify(value),
  toCopy: (value) => JSON.stringify(value),
  fromDb: (value) => value,
  key: (value) => JSON.stringify(value),
  apiType: "JSON",
};

/**
 * A column definition. The type parameters carry what TypeScript needs to infer row types:
 * the value type, whether it can be null, whether it has a default, whether it is the primary key.
 */
export class Column<
  T = unknown,
  TNotNull extends boolean = false,
  THasDefault extends boolean = false,
  TPrimary extends boolean = false,
  TInput = T,
> {
  declare readonly _type: T;
  /** What an insert or update accepts, when wider than what is read back. */
  declare readonly _input: TInput;
  declare readonly _notNull: TNotNull;
  declare readonly _hasDefault: THasDefault;
  declare readonly _primary: TPrimary;

  readonly codec: ColumnCodec<T>;
  readonly isNotNull: boolean;
  readonly isPrimaryKey: boolean;
  readonly defaultValue: (() => T) | undefined;

  constructor(codec: ColumnCodec<T>, notNull = false, primary = false, defaultValue?: () => T) {
    this.codec = codec;
    this.isNotNull = notNull || primary;
    this.isPrimaryKey = primary;
    this.defaultValue = defaultValue;
  }

  notNull(): Column<T, true, THasDefault, TPrimary, TInput> {
    return new Column(this.codec, true, this.isPrimaryKey, this.defaultValue);
  }

  primaryKey(): Column<T, true, THasDefault, true, TInput> {
    return new Column(this.codec, true, true, this.defaultValue);
  }

  /** Applied by Tidemark when an insert omits the column. A function is called for each insert. */
  default(value: T | (() => T)): Column<T, TNotNull, true, TPrimary, TInput> {
    const fn = typeof value === "function" ? (value as () => T) : () => value;
    return new Column(this.codec, this.isNotNull, this.isPrimaryKey, fn);
  }
}

// `any` here, not `unknown`: a column of any value type must be assignable, and Column is invariant in T.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyColumn = Column<any, boolean, boolean, boolean, any>;

/** Column constructors. */
export const t = {
  hex: () => new Column<Hex>(hexCodec),
  text: () => new Column<string>(textCodec),
  bigint: () => new Column<bigint>(bigintCodec),
  integer: () => new Column<number>(integerCodec),
  real: () => new Column<number>(realCodec),
  boolean: () => new Column<boolean>(booleanCodec),
  /** Reads back as a Date; accepts a Date or unix seconds (`event.block.timestamp`). */
  timestamp: () => new Column<Date, false, false, false, Date | bigint | number>(timestampCodec),
  json: <T = unknown>() => new Column<T>(jsonCodec as ColumnCodec<T>),
};
