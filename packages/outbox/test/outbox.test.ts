import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OutboxDelivery } from "@tidemark/engine";
import { describe, expect, it } from "vitest";
import {
  type KafkaModule,
  type NatsModule,
  PermanentDeliveryError,
  isForbiddenAddress,
  kafkaSender,
  natsSender,
  resolveWebhookTarget,
  signV4,
  signatureHeader,
  sqsSender,
  verifySignature,
  webhookSender,
} from "../src/index.js";

const delivery: OutboxDelivery = {
  destination: "d",
  kind: "event",
  attempt: 1,
  message: {
    id: "obx_1",
    type: "whale",
    specVersion: "1",
    build: "b",
    chainId: 1,
    block: { number: "5", hash: "0xab", timestamp: 1, finalized: true },
    checkpoint: "0",
    data: { amount: "1" },
  },
};

describe("signatures", () => {
  const secrets = ["a-long-enough-secret-1", "a-long-enough-secret-2"];
  it("signs with every secret and verifies against any", () => {
    const header = signatureHeader("{}", secrets, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    expect(verifySignature("{}", header, [secrets[1] as string], { now: 1_700_000_010 })).toBe(true);
    expect(verifySignature("{} ", header, secrets, { now: 1_700_000_010 })).toBe(false); // body changed
    expect(verifySignature("{}", header, ["another-secret-entirely"], { now: 1_700_000_010 })).toBe(false);
    expect(verifySignature("{}", header, secrets, { now: 1_700_001_000 })).toBe(false); // stale
    expect(verifySignature("{}", undefined, secrets)).toBe(false);
    expect(verifySignature("{}", "t=1,v1=zz", secrets)).toBe(false);
  });
});

describe("SSRF guard", () => {
  it("refuses private, loopback, link-local, metadata and reserved addresses, v4 and v6", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00:ec2::254",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::",
      "ff02::1",
      "not-an-ip",
    ]) {
      expect({ ip, forbidden: isForbiddenAddress(ip) }).toEqual({ ip, forbidden: true });
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect({ ip, forbidden: isForbiddenAddress(ip) }).toEqual({ ip, forbidden: false });
    }
  });

  it("needs https, no credentials, and every resolved address public", async () => {
    const resolve = (addresses: string[]) => async () =>
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    await expect(resolveWebhookTarget("http://example.com/x")).rejects.toThrow(PermanentDeliveryError);
    await expect(resolveWebhookTarget("https://u:p@example.com/x")).rejects.toThrow(/credentials/);
    await expect(resolveWebhookTarget("https://127.0.0.1/x")).rejects.toThrow(/non-public/);
    await expect(resolveWebhookTarget("https://[::1]/x")).rejects.toThrow(/non-public/);
    // One private address among public ones (DNS rebinding) is enough to refuse.
    await expect(
      resolveWebhookTarget("https://example.com/x", { resolve: resolve(["93.184.216.34", "10.0.0.1"]) }),
    ).rejects.toThrow(/10\.0\.0\.1/);
    const ok = await resolveWebhookTarget("https://example.com:8443/x", {
      resolve: resolve(["93.184.216.34"]),
    });
    expect(ok).toMatchObject({ hostname: "example.com", address: "93.184.216.34", family: 4 });
    // Development escape hatch.
    await expect(resolveWebhookTarget("http://127.0.0.1:9/x", { insecure: true })).resolves.toMatchObject({
      address: "127.0.0.1",
    });
  });
});

describe("webhook sender", () => {
  it("posts signed JSON, retries on 5xx and 429, gives up on other 4xx and redirects", async () => {
    let status = 200;
    const seen: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ headers: req.headers, body });
        res.writeHead(status, status === 302 ? { location: "http://169.254.169.254/" } : {});
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook?x=1`;
    const secrets = ["0123456789abcdef0123"];
    try {
      const sender = webhookSender({ kind: "webhook", url, secrets, insecure: true });
      await sender.send(delivery);
      const first = seen[0];
      expect(JSON.parse(first?.body ?? "")).toEqual(delivery.message);
      expect(first?.headers["tidemark-delivery"]).toBe("obx_1");
      expect(
        verifySignature(first?.body ?? "", first?.headers["tidemark-signature"] as string, secrets),
      ).toBe(true);
      for (const [code, permanent] of [
        [500, false],
        [503, false],
        [429, false],
        [400, true],
        [404, true],
        [302, true],
      ] as const) {
        status = code;
        const error = await sender.send(delivery).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect({ code, permanent: error instanceof PermanentDeliveryError }).toEqual({ code, permanent });
      }
      expect(seen.length).toBe(7); // the redirect was not followed
      // Without `insecure`, a loopback receiver is refused before any request.
      await expect(
        webhookSender({ kind: "webhook", url: url.replace("http:", "https:"), secrets }).send(delivery),
      ).rejects.toThrow(/non-public/);
      expect(seen.length).toBe(7);
    } finally {
      server.close();
    }
  });
});

describe("SigV4", () => {
  it("matches AWS's get-vanilla reference vector", () => {
    const headers = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("sends SQS SendMessage over the JSON protocol, FIFO-aware", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const sender = sqsSender(
      {
        kind: "sqs",
        queueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/events.fifo",
        region: "eu-west-1",
        credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
      },
      { fetch: fake },
    );
    await sender.send(delivery);
    const request = requests[0];
    expect(request?.url).toBe("https://sqs.eu-west-1.amazonaws.com/");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers["x-amz-target"]).toBe("AmazonSQS.SendMessage");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/sqs\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    const body = JSON.parse(request?.init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ MessageDeduplicationId: "obx_1-event", MessageGroupId: "1" });
    expect(JSON.parse(body.MessageBody as string)).toEqual(delivery.message);

    const failing = (code: number, text: string) =>
      sqsSender(
        {
          kind: "sqs",
          queueUrl: "https://sqs.eu-west-1.amazonaws.com/1/q",
          region: "eu-west-1",
          credentials: { accessKeyId: "a", secretAccessKey: "b" },
        },
        { fetch: (async () => new Response(text, { status: code })) as unknown as typeof fetch },
      ).send(delivery);
    await expect(failing(400, '{"__type":"InvalidParameterValue"}')).rejects.toThrow(PermanentDeliveryError);
    await expect(failing(400, '{"__type":"ThrottlingException"}')).rejects.not.toThrow(
      PermanentDeliveryError,
    );
    await expect(failing(500, "{}")).rejects.not.toThrow(PermanentDeliveryError);
  });
});

describe("broker senders", () => {
  it("publishes to NATS JetStream with the outbox id as message id, and reconnects after a failure", async () => {
    const published: { subject: string; data: string; msgID: string; headers: Map<string, string> }[] = [];
    let connects = 0;
    const mod: NatsModule = {
      headers: () => new Map<string, string>() as never,
      connect: async () => {
        connects++;
        if (connects === 1) throw new Error("connection refused");
        return {
          jetstream: () => ({
            publish: async (subject, data, options) => {
              published.push({
                subject,
                data: new TextDecoder().decode(data),
                msgID: options.msgID,
                headers: options.headers as never,
              });
            },
          }),
          drain: async () => undefined,
        };
      },
    };
    const sender = natsSender(
      { kind: "nats", servers: "nats://x", subject: "events" },
      { load: async () => mod },
    );
    await expect(sender.send(delivery)).rejects.toThrow("connection refused");
    await sender.send(delivery);
    expect(published[0]).toMatchObject({ subject: "events", msgID: "obx_1-event" });
    expect(published[0]?.headers.get("Tidemark-Type")).toBe("whale");
    expect(JSON.parse(published[0]?.data ?? "")).toEqual(delivery.message);
    await sender.close?.();
  });

  it("produces to Kafka keyed by outbox id with an idempotent producer", async () => {
    const sent: unknown[] = [];
    let producerOptions: unknown;
    const mod: KafkaModule = {
      Kafka: class {
        producer(options: unknown) {
          producerOptions = options;
          return {
            connect: async () => undefined,
            send: async (record: unknown) => {
              sent.push(record);
            },
            disconnect: async () => undefined,
          };
        }
      } as never,
    };
    const sender = kafkaSender(
      { kind: "kafka", brokers: ["k:9092"], topic: "events" },
      { load: async () => mod },
    );
    await sender.send(delivery);
    expect(producerOptions).toEqual({ idempotent: true, maxInFlightRequests: 1 });
    expect(sent[0]).toMatchObject({
      topic: "events",
      messages: [{ key: "obx_1", headers: { "tidemark-type": "whale", "tidemark-kind": "event" } }],
    });
    await sender.close?.();
  });

  it("explains a missing client package", async () => {
    const sender = natsSender(
      { kind: "nats", servers: "nats://x", subject: "s" },
      {
        load: async () => {
          throw new PermanentDeliveryError("the nats package is needed for this destination");
        },
      },
    );
    await expect(sender.send(delivery)).rejects.toThrow(/nats package/);
  });
});
