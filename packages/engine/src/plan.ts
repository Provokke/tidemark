import {
  BLOCK_TICK_TRANSACTION_INDEX,
  EventType,
  encodeCheckpoint,
  normalizeLogFilter,
} from "@tidemark/core";
import type { RpcBlockHeader, RpcLog, RpcTrace } from "@tidemark/rpc";
import { type FactorySpec, type SourceSpec, sourceHash } from "@tidemark/sync";
import {
  type AbiEvent,
  type AbiFunction,
  toEventSelector,
  toEventSignature,
  toFunctionSelector,
  toFunctionSignature,
} from "viem";
import { type Config, type Hex, isFactory } from "./config.js";
import { LogShapeError, compileEventDecoder, compileFunctionDecoder } from "./decode.js";
import type { AnyHandler, BlockInfo } from "./registry.js";

export interface EventPlan {
  /** The name the handler was registered under. */
  readonly key: string;
  readonly selector: Hex;
  readonly handler: AnyHandler;
  readonly decode: (topics: readonly Hex[], data: Hex) => unknown;
}

export interface CallPlan {
  readonly key: string;
  readonly selector: Hex;
  readonly handler: AnyHandler;
  readonly decode: ReturnType<typeof compileFunctionDecoder>;
}

interface PlanBase {
  /** The contract or block source name. */
  readonly name: string;
  readonly chainName: string;
  readonly chainId: number;
  readonly spec: SourceSpec;
  /** The source's sync cache key. */
  readonly hash: string;
  readonly startBlock: number;
  readonly endBlock: number | undefined;
  /** Breaks ties when two sources produce the same event. */
  readonly order: number;
}

export interface LogSourcePlan extends PlanBase {
  readonly kind: "log" | "factoryLog";
  readonly events: ReadonlyMap<Hex, EventPlan>;
  readonly includeTransaction: boolean;
  readonly includeReceipt: boolean;
}

export interface TraceSourcePlan extends PlanBase {
  readonly kind: "trace";
  readonly calls: ReadonlyMap<Hex, CallPlan>;
}

export interface BlockSourcePlan extends PlanBase {
  readonly kind: "block";
  readonly key: string;
  readonly handler: AnyHandler;
}

export type SourcePlan = LogSourcePlan | TraceSourcePlan | BlockSourcePlan;

const lower = (list: readonly Hex[]) => list.map((a) => a.toLowerCase() as Hex);
const NAME = "[A-Za-z][A-Za-z0-9_]*";

/**
 * Resolves every registered handler to a source: logs of a contract (by address or through a
 * factory), calls to a contract (traces), or interval blocks. Refuses names that match nothing,
 * ambiguous overloads, and anonymous events.
 */
export function planSources(config: Config, handlers: ReadonlyMap<string, AnyHandler>): SourcePlan[] {
  const events = new Map<string, EventPlan[]>();
  const calls = new Map<string, CallPlan[]>();
  const blocks = new Map<string, AnyHandler>();

  for (const [key, handler] of handlers) {
    const block = new RegExp(`^(${NAME}):block$`).exec(key);
    if (block?.[1] !== undefined && config.blocks?.[block[1]] !== undefined) {
      blocks.set(block[1], handler);
      continue;
    }
    const call = new RegExp(`^(${NAME})\\.(.+)$`).exec(key);
    if (call?.[1] !== undefined && call[2] !== undefined) {
      const contractName = call[1];
      const contract = config.contracts[contractName];
      if (contract === undefined) throw new Error(`handler ${key}: no contract named "${contractName}"`);
      if (contract.includeCallTraces !== true) {
        throw new Error(`handler ${key}: set includeCallTraces on ${contractName}`);
      }
      const ref = call[2].replaceAll(" ", "");
      const fns = contract.abi.filter((i): i is AbiFunction => i.type === "function");
      const exact = fns.filter((f) => toFunctionSignature(f) === ref);
      const matches =
        exact.length > 0 ? exact : ref.endsWith("()") ? fns.filter((f) => f.name === ref.slice(0, -2)) : [];
      if (matches.length === 0)
        throw new Error(`handler ${key}: ${contractName}'s ABI has no function ${ref}`);
      if (matches.length > 1) {
        const options = matches.map((m) => `${contractName}.${toFunctionSignature(m)}`).join(", ");
        throw new Error(`handler ${key}: ${ref} is overloaded; register one of ${options}`);
      }
      const item = matches[0] as AbiFunction;
      if (item.stateMutability === "view" || item.stateMutability === "pure") {
        throw new Error(
          `handler ${key}: ${item.name} is ${item.stateMutability}; only state-changing calls are traced`,
        );
      }
      const list = calls.get(contractName) ?? [];
      list.push({ key, selector: toFunctionSelector(item), handler, decode: compileFunctionDecoder(item) });
      calls.set(contractName, list);
      continue;
    }
    const colon = key.indexOf(":");
    const contractName = key.slice(0, colon);
    const eventRef = key.slice(colon + 1);
    const contract = config.contracts[contractName];
    if (colon < 1 || contract === undefined) {
      throw new Error(`handler ${key}: no contract or block source named "${contractName}"`);
    }
    const abiEvents = contract.abi.filter((item): item is AbiEvent => item.type === "event");
    const matches = eventRef.includes("(")
      ? abiEvents.filter((e) => toEventSignature(e) === eventRef.replaceAll(" ", ""))
      : abiEvents.filter((e) => e.name === eventRef);
    if (matches.length === 0)
      throw new Error(`handler ${key}: ${contractName}'s ABI has no event ${eventRef}`);
    if (matches.length > 1) {
      const options = matches.map((m) => `${contractName}:${toEventSignature(m)}`).join(", ");
      throw new Error(`handler ${key}: ${eventRef} is overloaded; register one of ${options}`);
    }
    const item = matches[0] as AbiEvent;
    if (item.anonymous === true)
      throw new Error(`handler ${key}: anonymous events cannot be filtered by signature`);
    const list = events.get(contractName) ?? [];
    list.push({ key, selector: toEventSelector(item), handler, decode: compileEventDecoder(item) });
    events.set(contractName, list);
  }

  const plans: SourcePlan[] = [];
  const chainOf = (chainName: string) => {
    const chain = config.chains[chainName];
    if (chain === undefined) throw new Error(`no chain ${chainName}`);
    return chain;
  };

  for (const [contractName, list] of events) {
    const contract = config.contracts[contractName];
    if (contract === undefined) continue;
    const chainId = chainOf(contract.chain).id;
    const byTopic = new Map<Hex, EventPlan>();
    for (const plan of list) {
      if (byTopic.has(plan.selector)) throw new Error(`two handlers for the same event on ${contractName}`);
      byTopic.set(plan.selector, plan);
    }
    const selectors = [...byTopic.keys()];
    const range = {
      startBlock: contract.startBlock,
      ...(contract.endBlock === undefined ? {} : { endBlock: contract.endBlock }),
    };
    const address = contract.address;
    let spec: SourceSpec;
    if (isFactory(address)) {
      const inputs = address.event.inputs;
      const target = inputs.find((i) => i.name === address.parameter);
      if (target === undefined)
        throw new Error(`contract ${contractName}: no factory argument ${address.parameter}`);
      const location: FactorySpec["location"] =
        target.indexed === true
          ? { topic: (inputs.filter((i) => i.indexed === true).indexOf(target) + 1) as 1 | 2 | 3 }
          : { word: inputs.filter((i) => i.indexed !== true).indexOf(target) };
      const factorySpec: FactorySpec = {
        chainId,
        address: lower(typeof address.address === "string" ? [address.address] : address.address),
        selector: toEventSelector(address.event),
        location,
      };
      spec = { kind: "factoryLog", factory: factorySpec, topics: [selectors, null, null, null], ...range };
    } else {
      spec = { kind: "log", filter: normalizeLogFilter({ chainId, address, topics: [selectors] }), ...range };
    }
    plans.push({
      kind: spec.kind,
      name: contractName,
      chainName: contract.chain,
      chainId,
      spec,
      hash: sourceHash(spec),
      startBlock: contract.startBlock,
      endBlock: contract.endBlock,
      order: plans.length,
      events: byTopic,
      includeTransaction: contract.includeTransaction === true,
      includeReceipt: contract.includeReceipt === true,
    });
  }

  for (const [contractName, list] of calls) {
    const contract = config.contracts[contractName];
    if (contract === undefined || isFactory(contract.address)) continue;
    const chainId = chainOf(contract.chain).id;
    const bySelector = new Map<Hex, CallPlan>(list.map((c) => [c.selector, c]));
    const spec: SourceSpec = {
      kind: "trace",
      chainId,
      to: lower(typeof contract.address === "string" ? [contract.address] : contract.address),
      selectors: [...bySelector.keys()],
      startBlock: contract.startBlock,
      ...(contract.endBlock === undefined ? {} : { endBlock: contract.endBlock }),
    };
    plans.push({
      kind: "trace",
      name: contractName,
      chainName: contract.chain,
      chainId,
      spec,
      hash: sourceHash(spec),
      startBlock: contract.startBlock,
      endBlock: contract.endBlock,
      order: plans.length,
      calls: bySelector,
    });
  }

  for (const [name, handler] of blocks) {
    const source = config.blocks?.[name];
    if (source === undefined) continue;
    const chainId = chainOf(source.chain).id;
    const spec: SourceSpec = {
      kind: "block",
      chainId,
      interval: source.interval,
      startBlock: source.startBlock,
      ...(source.endBlock === undefined ? {} : { endBlock: source.endBlock }),
    };
    plans.push({
      kind: "block",
      name,
      chainName: source.chain,
      chainId,
      spec,
      hash: sourceHash(spec),
      startBlock: source.startBlock,
      endBlock: source.endBlock,
      order: plans.length,
      key: `${name}:block`,
      handler,
    });
  }
  return plans;
}

/** An event ready for its handler. `event` has the shape the handler's name implies. */
export interface ReadyEvent {
  readonly key: string;
  readonly handler: AnyHandler;
  readonly source: SourcePlan;
  readonly event: { readonly name: string; readonly checkpoint: string; readonly block: BlockInfo } & Record<
    string,
    unknown
  >;
  /** For enrichment with the transaction and receipt. */
  readonly transactionHash?: Hex;
}

export class UndecodableLogError extends Error {
  override name = "UndecodableLogError";
}

const blockInfo = (number: number, hash: Hex, timestamp: number): BlockInfo => ({
  number: BigInt(number),
  hash,
  timestamp: BigInt(timestamp),
});

/** Decodes a log for the handler registered for its signature. */
export function decodeLog(source: LogSourcePlan, log: RpcLog & { blockTimestamp: number }): ReadyEvent {
  const selector = log.topics[0];
  const plan = selector === undefined ? undefined : source.events.get(selector);
  if (plan === undefined)
    throw new Error(`log ${log.blockNumber}:${log.logIndex} matched no handler of ${source.name}`);
  let args: unknown;
  try {
    args = plan.decode(log.topics, log.data);
  } catch (error) {
    // A log with the right topic0 that does not fit the event is a different event with the same
    // signature hash (ERC-20 and ERC-721 Transfer share one): not this handler's event.
    if (error instanceof LogShapeError) {
      throw new UndecodableLogError(`${plan.key} at block ${log.blockNumber} log ${log.logIndex}`, {
        cause: error,
      });
    }
    throw error;
  }
  return {
    key: plan.key,
    handler: plan.handler,
    source,
    transactionHash: log.transactionHash,
    event: {
      name: plan.key,
      args,
      log: { address: log.address, logIndex: log.logIndex, topics: log.topics, data: log.data },
      block: blockInfo(log.blockNumber, log.blockHash, log.blockTimestamp),
      transaction: { hash: log.transactionHash, index: log.transactionIndex },
      checkpoint: encodeCheckpoint({
        blockTimestamp: BigInt(log.blockTimestamp),
        chainId: BigInt(source.chainId),
        blockNumber: BigInt(log.blockNumber),
        transactionIndex: BigInt(log.transactionIndex),
        eventType: EventType.log,
        eventIndex: BigInt(log.logIndex),
      }),
    },
  };
}

/**
 * A call's position in its transaction as one sortable number: two decimal digits per level of the
 * call tree, eight levels deep, so depth-first order is numeric order. Calls deeper than eight
 * levels or wider than 98 subcalls share the position of their clamped prefix.
 */
function traceIndex(traceAddress: readonly number[]): bigint {
  let digits = "";
  for (let level = 0; level < 8; level++) {
    const position = traceAddress[level];
    digits += position === undefined ? "00" : String(Math.min(position, 97) + 1).padStart(2, "0");
  }
  return BigInt(digits);
}

/** Decodes a call for the handler registered for its function selector. */
export function decodeTrace(
  source: TraceSourcePlan,
  trace: RpcTrace & { blockTimestamp: number },
): ReadyEvent {
  const plan = source.calls.get(trace.input.slice(0, 10).toLowerCase() as Hex);
  if (plan === undefined)
    throw new Error(`call in ${trace.transactionHash} matched no handler of ${source.name}`);
  let args: readonly unknown[];
  let result: unknown;
  try {
    args = plan.decode.args(trace.input);
    result = plan.decode.result(trace.output);
  } catch (error) {
    if (error instanceof LogShapeError) {
      throw new UndecodableLogError(`${plan.key} in ${trace.transactionHash}`, { cause: error });
    }
    throw error;
  }
  return {
    key: plan.key,
    handler: plan.handler,
    source,
    transactionHash: trace.transactionHash,
    event: {
      name: plan.key,
      args,
      result,
      trace: {
        from: trace.from,
        to: trace.to,
        input: trace.input,
        output: trace.output,
        value: trace.value,
        gasUsed: trace.gasUsed,
        traceAddress: trace.traceAddress,
      },
      block: blockInfo(trace.blockNumber, trace.blockHash, trace.blockTimestamp),
      transaction: { hash: trace.transactionHash, index: trace.transactionIndex },
      checkpoint: encodeCheckpoint({
        blockTimestamp: BigInt(trace.blockTimestamp),
        chainId: BigInt(source.chainId),
        blockNumber: BigInt(trace.blockNumber),
        transactionIndex: BigInt(trace.transactionIndex),
        eventType: EventType.trace,
        eventIndex: traceIndex(trace.traceAddress),
      }),
    },
  };
}

/** A block event for an interval source. Sorts after every transaction in its block. */
export function blockEvent(source: BlockSourcePlan, header: RpcBlockHeader): ReadyEvent {
  return {
    key: source.key,
    handler: source.handler,
    source,
    event: {
      name: source.key,
      block: blockInfo(header.number, header.hash, header.timestamp),
      checkpoint: encodeCheckpoint({
        blockTimestamp: BigInt(header.timestamp),
        chainId: BigInt(source.chainId),
        blockNumber: BigInt(header.number),
        transactionIndex: BLOCK_TICK_TRANSACTION_INDEX,
        eventType: EventType.block,
        eventIndex: BigInt(source.order),
      }),
    },
  };
}

/** Orders ready events by checkpoint, then by source for events two sources share. */
export const compareReady = (a: ReadyEvent, b: ReadyEvent): number =>
  a.event.checkpoint < b.event.checkpoint
    ? -1
    : a.event.checkpoint > b.event.checkpoint
      ? 1
      : a.source.order - b.source.order;
