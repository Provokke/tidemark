import type { SqsDestination } from "@tidemark/engine";
import { PermanentDeliveryError } from "../errors.js";
import { type AwsCredentials, signV4 } from "@tidemark/core";
import { type Sender, retryableStatus } from "./types.js";

function credentialsFrom(destination: SqsDestination): AwsCredentials {
  if (destination.credentials !== undefined) return destination.credentials;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new PermanentDeliveryError(
      "no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or credentials",
    );
  }
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) };
}

/**
 * SQS SendMessage over the JSON protocol, signed with SigV4 (no AWS SDK). For a FIFO queue the
 * outbox id is the deduplication id, and the chain id the message group, so one chain's messages
 * stay in order.
 */
export function sqsSender(destination: SqsDestination, options: { fetch?: typeof fetch } = {}): Sender {
  const queue = new URL(destination.queueUrl);
  const endpoint = new URL(destination.endpoint ?? `${queue.protocol}//${queue.host}/`);
  const fifo = queue.pathname.endsWith(".fifo");
  const get = options.fetch ?? fetch;
  return {
    async send(delivery) {
      const { message } = delivery;
      const body = JSON.stringify({
        QueueUrl: destination.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          "tidemark-type": { DataType: "String", StringValue: message.type },
          "tidemark-id": { DataType: "String", StringValue: message.id },
        },
        ...(fifo
          ? {
              MessageDeduplicationId: `${message.id}-${delivery.kind}`,
              MessageGroupId: String(message.chainId),
            }
          : {}),
      });
      const headers = signV4({
        method: "POST",
        url: endpoint,
        headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "AmazonSQS.SendMessage" },
        body,
        region: destination.region,
        service: "sqs",
        credentials: credentialsFrom(destination),
      });
      delete headers.host; // fetch sets it
      const response = await get(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      const text = (await response.text()).slice(0, 300);
      const throttled = /Throttl|RequestThrottled|ServiceUnavailable/i.test(text);
      if (retryableStatus(response.status) || throttled) throw new Error(`SQS ${response.status}: ${text}`);
      throw new PermanentDeliveryError(`SQS ${response.status}: ${text}`);
    },
  };
}
