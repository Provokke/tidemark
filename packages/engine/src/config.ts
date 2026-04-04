import type { EndpointConfig, VerifyMode } from "@tidemark/rpc";
import type { Abi, AbiEvent } from "viem";

export type Hex = `0x${string}`;

export interface ChainConfig {
  readonly id: number;
  /** RPC endpoints in order of preference. */
  readonly rpc: string | readonly (string | EndpointConfig)[];
  /** `"tag"` uses the node's `finalized` block; `{ depth }` uses `head - depth` for chains without the tag. */
  readonly finality?: "tag" | { readonly depth: number };
  /** Largest `eth_getLogs` range to try. */
  readonly maxLogRange?: number;
  /**
   * Every block's timestamp is later than its parent's (true of Ethereum and OP-stack chains; not
   * of Arbitrum). Omnichain realtime ordering uses it to run a block without waiting for this chain
   * to produce a later one.
   */
  readonly strictTimestamps?: boolean;
  /**
   * How far to trust historical `eth_getLogs` answers: `head-check` (default), `bloom` (check each
   * block against its header's bloom, refetch what a range answer left out), or `receipts-root`
   * (derive logs from receipts proven against each header). Not part of the build id.
   */
  readonly verify?: VerifyMode;
}

/** Addresses discovered from a factory's announcing event. Build with `factory()`. */
export interface FactoryConfig {
  readonly kind: "factory";
  /** The factory contract (or contracts). */
  readonly address: Hex | readonly Hex[];
  /** The event that announces a new child. */
  readonly event: AbiEvent;
  /** The event argument holding the child's address. */
  readonly parameter: string;
}

export const factory = (args: Omit<FactoryConfig, "kind">): FactoryConfig => ({ kind: "factory", ...args });

export interface ContractConfig {
  readonly chain: string;
  readonly abi: Abi;
  /** A fixed address, a list, or `factory(...)` for every contract a factory creates. */
  readonly address: Hex | readonly Hex[] | FactoryConfig;
  readonly startBlock: number;
  /** Inclusive. Omit to follow the chain. */
  readonly endBlock?: number;
  /** Give log handlers the full transaction (`event.transaction`). */
  readonly includeTransaction?: boolean;
  /** Give log handlers the transaction receipt (`event.receipt`). */
  readonly includeReceipt?: boolean;
  /** Index successful calls to this contract's functions: handlers named `"Contract.fn()"`. */
  readonly includeCallTraces?: boolean;
}

/** A handler that runs every `interval` blocks: `"Name:block"`. */
export interface BlockSourceConfig {
  readonly chain: string;
  readonly interval: number;
  readonly startBlock: number;
  readonly endBlock?: number;
}

/** What the dispatcher sends: Tidemark's webhook payload, version 1. Integers are decimal strings. */
export interface OutboxMessage {
  /** Deterministic: the same for the same event in every build; dedupe on it. */
  readonly id: string;
  /** The topic, with `.retracted` appended for a retraction. */
  readonly type: string;
  readonly specVersion: "1";
  /** The build that produced it. */
  readonly build: string;
  readonly chainId: number;
  readonly block: {
    readonly number: string;
    readonly hash: Hex;
    readonly timestamp: number;
    readonly finalized: boolean;
  };
  readonly checkpoint: string;
  readonly data: unknown;
}

export interface OutboxDelivery {
  readonly destination: string;
  readonly kind: "event" | "retraction";
  /** 1 for the first try. */
  readonly attempt: number;
  readonly message: OutboxMessage;
}

/** An HTTPS endpoint. Requests are signed: `Tidemark-Signature: t=<unix>,v1=<hmac>[,v1=...]`. */
export interface WebhookDestination {
  readonly kind: "webhook";
  readonly url: string;
  /** HMAC-SHA256 keys. Every one signs (one `v1=` each), so a receiver can rotate without downtime. */
  readonly secrets: readonly string[];
  readonly timeoutMs?: number;
  /** Development only: allow `http:` and private, loopback and link-local addresses. */
  readonly insecure?: boolean;
}

export interface SqsDestination {
  readonly kind: "sqs";
  readonly queueUrl: string;
  readonly region: string;
  /** Default: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN from the environment. */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** Override the endpoint (a VPC endpoint, or a local stand-in). */
  readonly endpoint?: string;
}

/** NATS JetStream. Needs the `nats` package installed. The message id is the outbox id, for JetStream dedupe. */
export interface NatsDestination {
  readonly kind: "nats";
  readonly servers: string | readonly string[];
  readonly subject: string;
  readonly token?: string;
  readonly user?: string;
  readonly pass?: string;
}

/** Kafka. Needs the `kafkajs` package installed. The record key is the outbox id. */
export interface KafkaDestination {
  readonly kind: "kafka";
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly clientId?: string;
  readonly ssl?: boolean;
  readonly sasl?: {
    readonly mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
    readonly username: string;
    readonly password: string;
  };
}

/** Your own sender. Throw to retry later; throw `PermanentDeliveryError` to give up at once. */
export interface CustomDestination {
  readonly kind: "custom";
  send(delivery: OutboxDelivery): Promise<void>;
}

export type OutboxDestination =
  WebhookDestination | SqsDestination | NatsDestination | KafkaDestination | CustomDestination;

/** Where `context.outbox.emit` messages go. Not part of the build id: change it without re-indexing. */
export interface OutboxConfig {
  readonly destinations: Readonly<Record<string, OutboxDestination>>;
  /** Topic to destination names; `"*"` matches every topic. A topic with no route is kept, not sent. */
  readonly routes: Readonly<Record<string, readonly string[]>>;
  /** Tries before a delivery is dead (redrive it with `tidemark outbox redrive`). Default 12. */
  readonly maxAttempts?: number;
}

export interface Config {
  readonly chains: Readonly<Record<string, ChainConfig>>;
  readonly contracts: Readonly<Record<string, ContractConfig>>;
  readonly blocks?: Readonly<Record<string, BlockSourceConfig>>;
  /**
   * `per-chain` (default) indexes each chain in its own order. `omnichain` gives handlers one order
   * across every chain, by block timestamp: use it when handlers on different chains write the
   * same rows.
   */
  readonly ordering?: "per-chain" | "omnichain";
  readonly outbox?: OutboxConfig;
}

/** Declares a project's chains and contracts. Keeps the literal types handlers are inferred from. */
export const defineConfig = <const C extends Config>(config: C): C => config;

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const isFactory = (address: ContractConfig["address"]): address is FactoryConfig =>
  typeof address === "object" && "kind" in address;

/** Checks the parts of a config that types cannot. Throws one error listing every problem. */
export function validateConfig(config: Config): void {
  const problems: string[] = [];
  const ids = new Set<number>();
  for (const [name, chain] of Object.entries(config.chains)) {
    if (!NAME.test(name)) problems.push(`chain name "${name}" must be an identifier`);
    if (!Number.isSafeInteger(chain.id) || chain.id <= 0) {
      problems.push(`chain ${name}: id must be a positive integer`);
    }
    if (ids.has(chain.id)) problems.push(`chain ${name}: id ${chain.id} is used by another chain`);
    ids.add(chain.id);
    const rpcs = typeof chain.rpc === "string" ? [chain.rpc] : chain.rpc;
    if (rpcs.length === 0) problems.push(`chain ${name}: no RPC endpoints`);
    rpcs.forEach((rpc, i) => {
      if (typeof rpc !== "string" || !/^(https?|wss?):\/\/./i.test(rpc)) {
        // Usually an environment variable that is not set.
        problems.push(
          `chain ${name}: RPC endpoint ${i + 1} is ${rpc === "" ? "empty" : "not an http(s) or ws(s) URL"}`,
        );
      }
    });
    if (
      typeof chain.finality === "object" &&
      (!Number.isSafeInteger(chain.finality.depth) || chain.finality.depth < 0)
    ) {
      problems.push(`chain ${name}: finality depth must be a non-negative integer`);
    }
  }
  for (const [name, contract] of Object.entries(config.contracts)) {
    if (!NAME.test(name)) problems.push(`contract name "${name}" must be an identifier`);
    if (!(contract.chain in config.chains)) {
      problems.push(`contract ${name}: unknown chain "${contract.chain}"`);
    }
    const target = contract.address;
    const addresses = isFactory(target)
      ? typeof target.address === "string"
        ? [target.address]
        : target.address
      : typeof target === "string"
        ? [target]
        : target;
    if (addresses.length === 0) problems.push(`contract ${name}: no address`);
    for (const a of addresses) {
      if (!ADDRESS.test(a)) problems.push(`contract ${name}: "${a}" is not an address`);
    }
    if (isFactory(target)) {
      const input = target.event.inputs.find((i) => i.name === target.parameter);
      if (input === undefined) {
        problems.push(
          `contract ${name}: factory event ${target.event.name} has no argument ${target.parameter}`,
        );
      } else if (input.type !== "address") {
        problems.push(`contract ${name}: factory argument ${target.parameter} is not an address`);
      }
      if (target.event.anonymous === true)
        problems.push(`contract ${name}: a factory event cannot be anonymous`);
      if (contract.includeCallTraces === true) {
        problems.push(`contract ${name}: call traces of factory children are not supported yet`);
      }
    }
    if (!Number.isSafeInteger(contract.startBlock) || contract.startBlock < 0) {
      problems.push(`contract ${name}: startBlock must be a non-negative integer`);
    }
    if (contract.endBlock !== undefined && contract.endBlock < contract.startBlock) {
      problems.push(`contract ${name}: endBlock is before startBlock`);
    }
  }
  for (const [name, block] of Object.entries(config.blocks ?? {})) {
    if (!NAME.test(name)) problems.push(`block source name "${name}" must be an identifier`);
    if (name in config.contracts) problems.push(`block source ${name} has the same name as a contract`);
    if (!(block.chain in config.chains))
      problems.push(`block source ${name}: unknown chain "${block.chain}"`);
    if (!Number.isSafeInteger(block.interval) || block.interval < 1) {
      problems.push(`block source ${name}: interval must be a positive integer`);
    }
    if (!Number.isSafeInteger(block.startBlock) || block.startBlock < 0) {
      problems.push(`block source ${name}: startBlock must be a non-negative integer`);
    }
  }
  if (config.outbox !== undefined) problems.push(...outboxProblems(config.outbox));
  if (problems.length > 0) throw new Error(`invalid config:\n  ${problems.join("\n  ")}`);
}

function outboxProblems(outbox: OutboxConfig): string[] {
  const problems: string[] = [];
  for (const [name, d] of Object.entries(outbox.destinations)) {
    if (!NAME.test(name)) problems.push(`outbox destination "${name}" must be an identifier`);
    if (d.kind === "webhook") {
      let url: URL | undefined;
      try {
        url = new URL(d.url);
      } catch {
        problems.push(`outbox destination ${name}: "${d.url}" is not a URL`);
      }
      if (
        url !== undefined &&
        url.protocol !== "https:" &&
        !(d.insecure === true && url.protocol === "http:")
      ) {
        problems.push(
          `outbox destination ${name}: webhooks must use https (insecure: true allows http, for development)`,
        );
      }
      if (d.secrets.length === 0 || d.secrets.some((s) => s.length < 16)) {
        problems.push(
          `outbox destination ${name}: needs at least one signing secret of 16 or more characters`,
        );
      }
    }
  }
  for (const [topic, names] of Object.entries(outbox.routes)) {
    for (const n of names) {
      if (!(n in outbox.destinations)) problems.push(`outbox route ${topic}: no destination named "${n}"`);
    }
  }
  if (
    outbox.maxAttempts !== undefined &&
    (!Number.isSafeInteger(outbox.maxAttempts) || outbox.maxAttempts < 1)
  ) {
    problems.push("outbox maxAttempts must be a positive integer");
  }
  return problems;
}
