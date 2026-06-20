/**
 * The NATS and Kafka senders against real brokers. They run where the brokers are (CI starts
 * both); set TIDEMARK_TEST_NATS_URL (JetStream enabled) or TIDEMARK_TEST_KAFKA_BROKERS to run them.
 */
import type { OutboxDelivery } from "@tidemark/engine";
import { describe, expect, it } from "vitest";
import { kafkaSender, natsSender } from "../src/index.js";

const message = (id: string): OutboxDelivery => ({
  destination: "d",
  kind: "event",
  attempt: 1,
  message: {
    id,
    type: "whale",
    specVersion: "1",
    build: "b",
    chainId: 1,
    block: { number: "5", hash: "0xab", timestamp: 1, finalized: true },
    checkpoint: "0",
    data: { amount: "1" },
  },
});

const natsUrl = process.env.TIDEMARK_TEST_NATS_URL;
const kafkaBrokers = process.env.TIDEMARK_TEST_KAFKA_BROKERS;

describe.skipIf(natsUrl === undefined)("NATS JetStream", () => {
  it("publishes once per outbox id, with headers", async () => {
    const nats = await import("nats");
    const nc = await nats.connect({ servers: natsUrl as string });
    const jsm = await nc.jetstreamManager();
    const stream = `TM_${Date.now()}`;
    await jsm.streams.add({ name: stream, subjects: [`${stream}.events`], duplicate_window: 60_000_000_000 });
    const sender = natsSender({ kind: "nats", servers: natsUrl as string, subject: `${stream}.events` });
    try {
      await sender.send(message("obx_nats_1"));
      await sender.send(message("obx_nats_1")); // a re-send: JetStream drops it by message id
      await sender.send(message("obx_nats_2"));
      const info = await jsm.streams.info(stream);
      expect(info.state.messages).toBe(2);
      const first = await jsm.streams.getMessage(stream, { seq: 1 });
      expect(first.header.get("Tidemark-Type")).toBe("whale");
      expect(JSON.parse(new TextDecoder().decode(first.data))).toMatchObject({ id: "obx_nats_1" });
    } finally {
      await sender.close?.();
      await jsm.streams.delete(stream);
      await nc.drain();
    }
  });
});

describe.skipIf(kafkaBrokers === undefined)("Kafka", () => {
  it("produces records keyed by outbox id", async () => {
    const { Kafka, logLevel } = await import("kafkajs");
    const brokers = (kafkaBrokers as string).split(",");
    const kafka = new Kafka({ clientId: "tidemark-test", brokers, logLevel: logLevel.NOTHING });
    const topic = `tm-events-${Date.now()}`;
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
    const sender = kafkaSender({ kind: "kafka", brokers, topic });
    const consumer = kafka.consumer({ groupId: `g-${topic}` });
    try {
      await sender.send(message("obx_kafka_1"));
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });
      const received = await new Promise<{ key: string; type: string }>((resolve) => {
        void consumer.run({
          eachMessage: async ({ message: m }) => {
            resolve({ key: m.key?.toString() ?? "", type: m.headers?.["tidemark-type"]?.toString() ?? "" });
          },
        });
      });
      expect(received).toEqual({ key: "obx_kafka_1", type: "whale" });
    } finally {
      await consumer.disconnect();
      await sender.close?.();
      await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
      await admin.disconnect();
    }
  }, 60_000);
});
