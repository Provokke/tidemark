import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { WebhookDestination } from "@tidemark/engine";
import { PermanentDeliveryError } from "../errors.js";
import { signatureHeader } from "../signing.js";
import { resolveWebhookTarget } from "../ssrf.js";
import { type Sender, retryableStatus } from "./types.js";

export interface WebhookOptions {
  /** For tests: a resolver in place of DNS. */
  readonly resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  readonly now?: () => number;
}

/**
 * POSTs each message as JSON to an HTTPS URL, signed with every secret. The URL is vetted on every
 * send (DNS can change) and the connection is pinned to the vetted address; redirects are never
 * followed. 2xx is success; 408, 425, 429 and 5xx retry; any other answer is permanent.
 */
export function webhookSender(destination: WebhookDestination, options: WebhookOptions = {}): Sender {
  const timeoutMs = destination.timeoutMs ?? 10_000;
  return {
    async send(delivery) {
      const target = await resolveWebhookTarget(destination.url, {
        ...(destination.insecure === undefined ? {} : { insecure: destination.insecure }),
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      });
      const body = JSON.stringify(delivery.message);
      const now = (options.now ?? Date.now)() / 1000;
      const headers = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "user-agent": "tidemark-outbox/1",
        "tidemark-signature": signatureHeader(body, destination.secrets, now),
        "tidemark-delivery": delivery.message.id,
        "tidemark-attempt": String(delivery.attempt),
      };
      const pinned: LookupFunction = (_host, opts, callback) => {
        if (opts.all === true) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      };
      const status = await new Promise<number>((resolve, reject) => {
        const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(
          {
            protocol: target.url.protocol,
            hostname: target.hostname,
            port: target.url.port === "" ? undefined : Number(target.url.port),
            path: `${target.url.pathname}${target.url.search}`,
            method: "POST",
            headers,
            lookup: pinned,
            servername: target.hostname,
            timeout: timeoutMs,
          },
          (response) => {
            // Drain (bounded) so the socket is released; the body is not used.
            let seen = 0;
            response.on("data", (chunk: Buffer) => {
              seen += chunk.length;
              if (seen > 64 * 1024) response.destroy();
            });
            response.on("end", () => {
              resolve(response.statusCode ?? 0);
            });
            response.on("close", () => {
              resolve(response.statusCode ?? 0);
            });
            response.on("error", reject);
          },
        );
        request.on("timeout", () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
        request.on("error", reject);
        request.end(body);
      });
      if (status >= 200 && status < 300) return;
      if (status >= 300 && status < 400)
        throw new PermanentDeliveryError(`HTTP ${status}: redirects are not followed`);
      if (retryableStatus(status)) throw new Error(`HTTP ${status}`);
      throw new PermanentDeliveryError(`HTTP ${status}`);
    },
  };
}
