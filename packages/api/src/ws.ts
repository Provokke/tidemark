import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { LiveQueries } from "./live.js";

/** The subprotocol of the `graphql-ws` library: `graphql-transport-ws`. */
export const GRAPHQL_WS_PROTOCOL = "graphql-transport-ws";

interface Upgradable {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

export interface WebSocketOptions {
  readonly live: LiveQueries;
  readonly path?: string;
  /** SHA-256 hex digests of accepted API keys; the key comes in `connection_init`'s payload or the header. */
  readonly apiKeyHashes?: readonly string[];
  /** Live queries per connection. Default 50. */
  readonly maxPerConnection?: number;
  /** Close a connection that does not send `connection_init` within this. Default 10 s. */
  readonly initTimeoutMs?: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Serves live queries over WebSocket with the `graphql-transport-ws` protocol, so `graphql-ws`
 * clients work as they are. Every operation is live: a `subscribe` with a query gets a `next` with
 * the result at once and another each time the result changes, until the client sends `complete`.
 */
export function attachWebSocket(server: Upgradable, options: WebSocketOptions): { close(): Promise<void> } {
  const path = options.path ?? "/graphql/ws";
  const keys = options.apiKeyHashes === undefined ? undefined : new Set(options.apiKeyHashes);
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(GRAPHQL_WS_PROTOCOL) ? GRAPHQL_WS_PROTOCOL : false),
    maxPayload: 256 * 1024,
  });

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      handle(ws, req);
    });
  });

  const handle = (ws: WebSocket, req: IncomingMessage) => {
    if (ws.protocol !== GRAPHQL_WS_PROTOCOL) {
      ws.close(1002, "subprotocol must be graphql-transport-ws");
      return;
    }
    let acknowledged = false;
    const subs = new Map<string, () => void>();
    const send = (message: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const initTimer = setTimeout(() => {
      if (!acknowledged) ws.close(4408, "connection initialisation timeout");
    }, options.initTimeoutMs ?? 10_000);

    ws.on("message", (raw: Buffer) => {
      let message: { type?: unknown; id?: unknown; payload?: unknown };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        ws.close(4400, "invalid message");
        return;
      }
      switch (message.type) {
        case "connection_init": {
          if (acknowledged) {
            ws.close(4429, "too many initialisation requests");
            return;
          }
          if (keys !== undefined) {
            const payload = (message.payload ?? {}) as { authorization?: unknown };
            const header =
              typeof payload.authorization === "string"
                ? payload.authorization
                : (req.headers.authorization ?? "");
            const key = header.startsWith("Bearer ") ? header.slice(7) : "";
            if (key === "" || !keys.has(sha256(key))) {
              ws.close(4403, "forbidden");
              return;
            }
          }
          acknowledged = true;
          clearTimeout(initTimer);
          send({ type: "connection_ack" });
          return;
        }
        case "ping":
          send({ type: "pong" });
          return;
        case "pong":
          return;
        case "subscribe": {
          if (!acknowledged) {
            ws.close(4401, "unauthorized");
            return;
          }
          const id = message.id;
          if (typeof id !== "string" || id === "") {
            ws.close(4400, "subscribe needs an id");
            return;
          }
          if (subs.has(id)) {
            ws.close(4409, `subscriber for ${id} already exists`);
            return;
          }
          if (subs.size >= (options.maxPerConnection ?? 50)) {
            send({ type: "error", id, payload: [{ message: "too many live queries on this connection" }] });
            return;
          }
          const payload = (message.payload ?? {}) as {
            query?: unknown;
            variables?: unknown;
            operationName?: unknown;
          };
          subs.set(id, () => undefined); // reserve the id while subscribing
          options.live
            .subscribe({ graphql: payload }, (result) => {
              if (!subs.has(id)) return;
              const body = result.body as { data?: unknown; errors?: unknown; error?: unknown };
              if (result.status >= 400 && body.data === undefined) {
                const errors = body.errors ?? [
                  { message: typeof body.error === "string" ? body.error : `status ${result.status}` },
                ];
                send({ type: "error", id, payload: errors });
                subs.get(id)?.();
                subs.delete(id);
                return;
              }
              send({ type: "next", id, payload: body });
            })
            .then(({ unsubscribe }) => {
              if (subs.has(id)) subs.set(id, unsubscribe);
              else unsubscribe(); // completed (or errored) while subscribing
            })
            .catch((error: unknown) => {
              subs.delete(id);
              send({
                type: "error",
                id,
                payload: [{ message: error instanceof Error ? error.message : String(error) }],
              });
            });
          return;
        }
        case "complete": {
          const id = message.id;
          if (typeof id === "string") {
            subs.get(id)?.();
            subs.delete(id);
          }
          return;
        }
        default:
          ws.close(4400, "unknown message type");
      }
    });
    ws.on("close", () => {
      clearTimeout(initTimer);
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
    });
  };

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          resolve();
        });
      }),
  };
}
