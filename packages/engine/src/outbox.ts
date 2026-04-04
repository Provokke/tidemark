import { createHash } from "node:crypto";
import { internalTable, t } from "@tidemark/schema";
import type { Db } from "@tidemark/store";
import type { Hex } from "./config.js";

/**
 * Side effects a handler asks for. Rows live in the build's schema and are written with the
 * handler's other writes, in the same transaction, journaled like any table: a reorg deletes the
 * rows of the blocks it removes. The dispatcher (`@tidemark/outbox`) delivers them.
 */
export const outboxTable = internalTable("_tm_outbox", {
  id: t.text().primaryKey(),
  topic: t.text().notNull(),
  payload: t.json().notNull(),
  /** `finalized`: delivered once the block is final. `latest`: at once, retracted if reorged. */
  deliveryWhen: t.text().notNull(),
  chainId: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  blockHash: t.hex().notNull(),
  blockTimestamp: t.bigint().notNull(),
  checkpoint: t.text().notNull(),
});

export type DeliveryWhen = "latest" | "finalized";

export interface Outbox {
  /**
   * Queues a side effect for delivery to the destinations configured for `topic`. `payload` must be
   * JSON-serialisable; bigints become decimal strings. With `when: "finalized"` (the default) it is
   * delivered once its block is final and never needs undoing; with `"latest"` it is delivered at
   * once, and if a reorg removes its block a `<topic>.retracted` delivery with the same id follows.
   */
  emit(topic: string, payload: unknown, options?: { readonly when?: DeliveryWhen }): Promise<void>;
}

const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * An outbox id: the same for the same event in any build (so a redeploy does not re-send history,
 * and receivers can dedupe), and different for the same position in a reorged block (the block hash
 * is part of it).
 */
export function outboxId(input: {
  chainId: number;
  blockHash: Hex;
  checkpoint: string;
  topic: string;
  ordinal: number;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.chainId,
        input.blockHash.toLowerCase(),
        input.checkpoint,
        input.topic,
        input.ordinal,
      ]),
    )
    .digest("hex");
  return `obx_${hash.slice(0, 40)}`;
}

/** JSON with bigints as decimal strings; anything else that JSON cannot hold is an error. */
export function toOutboxPayload(payload: unknown, topic: string): unknown {
  let text: string | undefined;
  try {
    // undefined for a payload that is undefined or a function, whatever the type says.
    text = JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ) as string | undefined;
  } catch (error) {
    throw new TypeError(`outbox ${topic}: payload is not JSON-serialisable: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (text === undefined) throw new TypeError(`outbox ${topic}: payload is not JSON-serialisable`);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`outbox ${topic}: payload is over ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return JSON.parse(text) as unknown;
}

/** The outbox a handler gets for one event. Ordinals count emits within the event. */
export function eventOutbox(
  db: Db,
  event: { chainId: number; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint; checkpoint: string },
): Outbox {
  let ordinal = 0;
  return {
    async emit(topic, payload, options) {
      if (!TOPIC.test(topic)) throw new TypeError(`outbox topic "${topic}" must match ${String(TOPIC)}`);
      // Checked at run time too: handlers in plain JavaScript have no types to stop them.
      const when: string = options?.when ?? "finalized";
      if (when !== "latest" && when !== "finalized")
        throw new TypeError(`outbox ${topic}: when must be "latest" or "finalized"`);
      const id = outboxId({
        chainId: event.chainId,
        blockHash: event.blockHash,
        checkpoint: event.checkpoint,
        topic,
        ordinal: ordinal++,
      });
      await db.insert(outboxTable).values({
        id,
        topic,
        payload: toOutboxPayload(payload, topic),
        deliveryWhen: when as DeliveryWhen,
        chainId: BigInt(event.chainId),
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        blockTimestamp: event.blockTimestamp,
        checkpoint: event.checkpoint,
      });
    },
  };
}
