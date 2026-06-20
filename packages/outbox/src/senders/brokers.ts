import type { KafkaDestination, NatsDestination } from "@tidemark/engine";
import { PermanentDeliveryError } from "../errors.js";
import type { Sender } from "./types.js";

/** The part of the `nats` package used here. */
export interface NatsModule {
  connect(options: { servers: string | string[]; token?: string; user?: string; pass?: string }): Promise<{
    jetstream(): {
      publish(
        subject: string,
        data: Uint8Array,
        options: { msgID: string; headers: { set(key: string, value: string): void } },
      ): Promise<unknown>;
    };
    drain(): Promise<void>;
  }>;
  headers(): { set(key: string, value: string): void };
}

/** The part of the `kafkajs` package used here. */
export interface KafkaModule {
  Kafka: new (config: {
    clientId: string;
    brokers: string[];
    ssl?: boolean;
    sasl?: { mechanism: string; username: string; password: string };
  }) => {
    producer(options: { idempotent: boolean; maxInFlightRequests: number }): {
      connect(): Promise<void>;
      send(record: {
        topic: string;
        messages: { key: string; value: string; headers: Record<string, string> }[];
      }): Promise<unknown>;
      disconnect(): Promise<void>;
    };
  };
}

async function loadOptional<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (error) {
    throw new PermanentDeliveryError(
      `the ${name} package is needed for this destination: install it next to Tidemark`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Publishes to a NATS JetStream subject with the outbox id as the message id, so JetStream's
 * duplicate window drops a re-send. Needs the `nats` package.
 */
export function natsSender(
  destination: NatsDestination,
  options: { load?: () => Promise<NatsModule> } = {},
): Sender {
  let connection: ReturnType<NatsModule["connect"]> | undefined;
  let mod: NatsModule | undefined;
  return {
    async send(delivery) {
      mod ??= await (options.load ?? (() => loadOptional<NatsModule>("nats")))();
      const m = mod;
      connection ??= m
        .connect({
          servers: typeof destination.servers === "string" ? destination.servers : [...destination.servers],
          ...(destination.token === undefined ? {} : { token: destination.token }),
          ...(destination.user === undefined ? {} : { user: destination.user }),
          ...(destination.pass === undefined ? {} : { pass: destination.pass }),
        })
        .catch((error: unknown) => {
          connection = undefined; // try again next time
          throw error;
        });
      const nc = await connection;
      const headers = m.headers();
      headers.set("Tidemark-Type", delivery.message.type);
      headers.set("Tidemark-Kind", delivery.kind);
      await nc
        .jetstream()
        .publish(destination.subject, new TextEncoder().encode(JSON.stringify(delivery.message)), {
          msgID: `${delivery.message.id}-${delivery.kind}`,
          headers,
        });
    },
    async close() {
      const c = connection;
      connection = undefined;
      if (c !== undefined) await (await c).drain();
    },
  };
}

/**
 * Produces to a Kafka topic, keyed by the outbox id, with an idempotent producer. Needs the
 * `kafkajs` package.
 */
export function kafkaSender(
  destination: KafkaDestination,
  options: { load?: () => Promise<KafkaModule> } = {},
): Sender {
  type Producer = ReturnType<InstanceType<KafkaModule["Kafka"]>["producer"]>;
  let producer: Promise<Producer> | undefined;
  const connect = async (): Promise<Producer> => {
    const { Kafka } = await (options.load ?? (() => loadOptional<KafkaModule>("kafkajs")))();
    const kafka = new Kafka({
      clientId: destination.clientId ?? "tidemark-outbox",
      brokers: [...destination.brokers],
      ...(destination.ssl === undefined ? {} : { ssl: destination.ssl }),
      ...(destination.sasl === undefined ? {} : { sasl: { ...destination.sasl } }),
    });
    const p = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await p.connect();
    return p;
  };
  return {
    async send(delivery) {
      producer ??= connect().catch((error: unknown) => {
        producer = undefined;
        throw error;
      });
      await (
        await producer
      ).send({
        topic: destination.topic,
        messages: [
          {
            key: delivery.message.id,
            value: JSON.stringify(delivery.message),
            headers: { "tidemark-type": delivery.message.type, "tidemark-kind": delivery.kind },
          },
        ],
      });
    },
    async close() {
      const p = producer;
      producer = undefined;
      if (p !== undefined) await (await p).disconnect();
    },
  };
}
