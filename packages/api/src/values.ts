/** Turns a value from the Postgres driver into JSON: bigints as strings, bytes as 0x hex, dates as ISO. */
export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonValue(v)]),
    );
  }
  return value;
}

/** Postgres type OIDs the client decodes specially. */
export const PG_TYPES = {
  int8: 20,
  numeric: 1700,
  bytea: 17,
  timestamptz: 1184,
  timestamp: 1114,
} as const;
