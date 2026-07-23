import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Faults the proxy injects. All can be changed while it runs, through `proxy.faults`.
 */
export interface RpcFaults {
  /**
   * Pretend to be this many blocks behind: `eth_blockNumber` and `latest` answer `head - lag`,
   * blocks above that are `null`, and `eth_getLogs` silently drops logs above it, the way Erigon,
   * Besu and reth answer a range past their head.
   */
  lagBlocks?: number;
  /** Refuse `eth_getLogs` over more than this many blocks, in `rangeErrorStyle`. */
  maxLogRange?: number;
  /** Refuse `eth_getLogs` that would return more than this many logs, Infura style. */
  maxLogResults?: number;
  rangeErrorStyle?: "alchemy" | "infura" | "plain" | "http-413";
  /** Probability of an HTTP 500 per request. */
  failRate?: number;
  /** Probability of an HTTP 429 with `Retry-After: 1`. */
  rateLimitRate?: number;
  /** Probability of a response that is not JSON. */
  garbleRate?: number;
  /** Probability of never answering (the client must time out). */
  hangRate?: number;
  /** Added before every response. */
  latencyMs?: number;
  /** Answer `eth_chainId` with this instead of the target's. */
  chainId?: number;
  /** Reject JSON-RPC batches with a single error, as some providers do. */
  noBatch?: boolean;
  /**
   * Leave these blocks' logs out of ranged `eth_getLogs` answers (`blockHash` queries still answer
   * honestly): a node that answers a range short without saying so.
   */
  omitLogsInBlocks?: readonly number[];
}

interface Call {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: unknown[];
}

interface Reply {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type Cassette = Record<string, Omit<Reply, "jsonrpc" | "id">>;

export interface RpcProxy {
  readonly url: string;
  faults: RpcFaults;
  /** Requests by JSON-RPC method (batch elements counted individually). */
  readonly calls: Map<string, number>;
  /** What was recorded, when started with `record: true`. */
  readonly cassette: Cassette;
  totalCalls(method?: string): number;
  resetCalls(): void;
  stop(): Promise<void>;
}

export interface RpcProxyOptions {
  /** Upstream URL. Omit to serve only from `replay`. */
  target?: string;
  faults?: RpcFaults;
  /** Seed for the random faults, so a failing run can be replayed. */
  seed?: number;
  record?: boolean;
  replay?: Cassette;
  /** Told every JSON-RPC call (batch elements one by one) before it is handled. */
  onCall?: (method: string, params: readonly unknown[]) => void;
}

/** Request key for recording and replay: method and params, without the id. */
export function cassetteKey(method: string, params: unknown): string {
  return JSON.stringify([method, params ?? []]);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n: number) => `0x${n.toString(16)}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A JSON-RPC proxy that injects faults between a client and a node (usually Anvil), and can
 * record its traffic to a cassette or serve a recorded cassette with no node behind it.
 */
export async function startRpcProxy(options: RpcProxyOptions): Promise<RpcProxy> {
  const random = mulberry32(options.seed ?? 1);
  const calls = new Map<string, number>();
  const cassette: Cassette = {};
  const state = { faults: { ...options.faults } };
  const hung: ServerResponse[] = [];

  async function upstream(method: string, params: unknown[]): Promise<Omit<Reply, "jsonrpc" | "id">> {
    if (options.replay !== undefined) {
      const recorded = options.replay[cassetteKey(method, params)];
      return (
        recorded ?? { error: { code: -32603, message: `not in cassette: ${cassetteKey(method, params)}` } }
      );
    }
    if (options.target === undefined) throw new Error("proxy has neither a target nor a cassette");
    const response = await fetch(options.target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as Reply;
    const out = body.error === undefined ? { result: body.result } : { error: body.error };
    if (options.record === true) cassette[cassetteKey(method, params)] = out;
    return out;
  }

  async function realHead(): Promise<number> {
    const reply = await upstream("eth_blockNumber", []);
    return Number.parseInt(String(reply.result), 16);
  }

  async function handle(call: Call): Promise<Omit<Reply, "jsonrpc" | "id">> {
    calls.set(call.method, (calls.get(call.method) ?? 0) + 1);
    options.onCall?.(call.method, call.params ?? []);
    const params = call.params ?? [];
    const f = state.faults;
    const lag = f.lagBlocks ?? 0;

    switch (call.method) {
      case "eth_chainId":
        if (f.chainId !== undefined) return { result: hex(f.chainId) };
        break;
      case "eth_blockNumber":
        if (lag > 0) return { result: hex(Math.max(0, (await realHead()) - lag)) };
        break;
      case "eth_getBlockByNumber": {
        if (lag === 0) break;
        const [ref, full] = params as [string, boolean];
        const visible = Math.max(0, (await realHead()) - lag);
        if (ref === "latest" || ref === "pending") return upstream(call.method, [hex(visible), full]);
        if (ref.startsWith("0x") && Number.parseInt(ref, 16) > visible) return { result: null };
        break;
      }
      case "eth_getLogs": {
        const [filter] = params as [{ fromBlock?: string; toBlock?: string }];
        const from = Number.parseInt(filter.fromBlock ?? "0x0", 16);
        const to = Number.parseInt(filter.toBlock ?? "0x0", 16);
        const span = to - from + 1;
        if (f.maxLogRange !== undefined && span > f.maxLogRange) {
          return rangeError(f.rangeErrorStyle ?? "alchemy", from, f.maxLogRange);
        }
        const reply = await upstream(call.method, params);
        if (!Array.isArray(reply.result)) return reply;
        let logs = reply.result as { blockNumber: string }[];
        if (lag > 0) {
          const visible = Math.max(0, (await realHead()) - lag);
          logs = logs.filter((log) => Number.parseInt(log.blockNumber, 16) <= visible);
        }
        const omit = f.omitLogsInBlocks;
        if (omit !== undefined && omit.length > 0 && filter.fromBlock !== undefined) {
          logs = logs.filter((log) => !omit.includes(Number.parseInt(log.blockNumber, 16)));
        }
        if (f.maxLogResults !== undefined && logs.length > f.maxLogResults) {
          return {
            error: { code: -32005, message: `query returned more than ${f.maxLogResults} results` },
          };
        }
        return { result: logs };
      }
    }
    return upstream(call.method, params);
  }

  function rangeError(style: NonNullable<RpcFaults["rangeErrorStyle"]>, from: number, max: number) {
    switch (style) {
      case "alchemy":
        return {
          error: {
            code: -32602,
            message:
              "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. " +
              `Based on your parameters, this block range should work: [${hex(from)}, ${hex(from + max - 1)}]`,
          },
        };
      case "infura":
        return {
          error: {
            code: -32005,
            message: `query returned more than 10000 results. Try with this block range [${hex(from)}, ${hex(from + max - 1)}].`,
            data: { from: hex(from), to: hex(from + max - 1), limit: 10000 },
          },
        };
      case "plain":
        return { error: { code: -32000, message: `exceed maximum block range: ${max}` } };
      case "http-413":
        return { status: 413 } as never;
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const f = state.faults;
      if ((f.latencyMs ?? 0) > 0) await new Promise((r) => setTimeout(r, f.latencyMs));
      if (random() < (f.hangRate ?? 0)) {
        hung.push(res);
        return;
      }
      if (random() < (f.failRate ?? 0)) {
        res.writeHead(500).end("internal error");
        return;
      }
      if (random() < (f.rateLimitRate ?? 0)) {
        res.writeHead(429, { "retry-after": "1" }).end("too many requests");
        return;
      }
      if (random() < (f.garbleRate ?? 0)) {
        res.writeHead(200, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","id":');
        return;
      }

      let parsed: Call | Call[];
      try {
        parsed = JSON.parse(await readBody(req)) as Call | Call[];
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (Array.isArray(parsed) && f.noBatch === true) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "batch requests are not supported" },
          }),
        );
        return;
      }

      const list = Array.isArray(parsed) ? parsed : [parsed];
      const replies: Reply[] = [];
      for (const call of list) {
        const out = await handle(call);
        if ((out as { status?: number }).status === 413) {
          res.writeHead(413).end("request entity too large");
          return;
        }
        replies.push({ jsonrpc: "2.0", id: call.id, ...out });
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(502).end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get faults() {
      return state.faults;
    },
    set faults(value: RpcFaults) {
      state.faults = { ...value };
    },
    calls,
    cassette,
    totalCalls(method?: string) {
      if (method !== undefined) return calls.get(method) ?? 0;
      return [...calls.values()].reduce((a, b) => a + b, 0);
    },
    resetCalls() {
      calls.clear();
    },
    async stop() {
      for (const res of hung) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
