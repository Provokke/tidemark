import type { Db } from "@tidemark/store";
import type {
  Abi,
  AbiEvent,
  AbiParameter,
  AbiParameterToPrimitiveType,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
} from "viem";
import type { Config, Hex } from "./config.js";
import type { Outbox } from "./outbox.js";

type ContractName<C extends Config> = keyof C["contracts"] & string;
type AbiOf<C extends Config, K extends ContractName<C>> = C["contracts"][K]["abi"];
type Mutability = "nonpayable" | "payable";
type WriteFunctionName<A extends Abi> = ContractFunctionName<A, Mutability>;

/** The events of an ABI that a handler can be registered for (anonymous ones have no selector). */
type EventsOf<A> = A extends readonly unknown[]
  ? Exclude<Extract<A[number], AbiEvent>, { anonymous: true }>
  : never;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** A parameter's type as it appears in a signature: tuples spelled out, `(uint256,address)[]`. */
type CanonicalType<P> = P extends {
  type: `tuple${infer Suffix}`;
  components: infer Cs extends readonly AbiParameter[];
}
  ? `(${JoinTypes<Cs>})${Suffix}`
  : P extends { type: infer T extends string }
    ? T
    : never;
type JoinTypes<Ps extends readonly unknown[]> = Ps extends readonly [infer H, ...infer R]
  ? R extends readonly []
    ? CanonicalType<H>
    : `${CanonicalType<H>},${JoinTypes<R>}`
  : "";

/** `Transfer(address,address,uint256)`: what `toEventSignature` gives, and what handlers may name. */
export type EventSignature<E extends AbiEvent> = `${E["name"]}(${JoinTypes<E["inputs"]>})`;

/** An event's names: its signature always, and its bare name when the name is not overloaded. */
type EventRefs<A> = {
  [N in EventsOf<A>["name"]]: IsUnion<Extract<EventsOf<A>, { name: N }>> extends true
    ? EventSignature<Extract<EventsOf<A>, { name: N }>>
    : N | EventSignature<Extract<EventsOf<A>, { name: N }>>;
}[EventsOf<A>["name"]];

/** `"Contract:Event"` (or `"Contract:Event(types)"`) for every event of every contract in the config. */
export type EventName<C extends Config> = {
  [K in ContractName<C>]: `${K}:${EventRefs<AbiOf<C, K>>}`;
}[ContractName<C>];

/** Indexed strings, bytes, arrays and tuples are stored, and so decoded, as their keccak256. */
type HashedInTopic<P> = P extends { indexed: true; type: infer T extends string }
  ? T extends "string" | "bytes" | `tuple${string}` | `${string}]`
    ? true
    : false
  : false;
type ParamValue<P extends AbiParameter> =
  HashedInTopic<P> extends true ? Hex : AbiParameterToPrimitiveType<P>;
type AllNamed<Ps extends readonly AbiParameter[]> = Ps extends readonly []
  ? false
  : Extract<Ps[number], { name: "" } | { name?: undefined }> extends never
    ? true
    : false;

/** What the decoder returns for an event: an object by name when every input is named, else a tuple. */
export type DecodedEventArgs<E extends AbiEvent> =
  AllNamed<E["inputs"]> extends true
    ? { readonly [P in E["inputs"][number] as P["name"] & string]: ParamValue<P> }
    : {
        readonly [I in keyof E["inputs"]]: E["inputs"][I] extends AbiParameter
          ? ParamValue<E["inputs"][I]>
          : never;
      };

type FindEvent<A, Ref extends string> = Ref extends `${string}(${string}`
  ? { [N in EventsOf<A>["name"]]: Extract<EventsOf<A>, { name: N }> }[EventsOf<A>["name"]] extends infer E
    ? E extends AbiEvent
      ? Ref extends EventSignature<E>
        ? E
        : never
      : never
    : never
  : Extract<EventsOf<A>, { name: Ref }>;

/** `"Contract.fn()"` for every state-changing function of every contract in the config. */
export type CallName<C extends Config> = {
  [K in ContractName<C>]: `${K}.${WriteFunctionName<AbiOf<C, K>>}()`;
}[ContractName<C>];

/** `"Name:block"` for every block source. */
export type BlockName<C extends Config> = `${keyof NonNullable<C["blocks"]> & string}:block`;

type Split<N extends string> = N extends `${infer K}:${infer E}` ? [K, E] : never;
type SplitCall<N extends string> = N extends `${infer K}.${infer F}()` ? [K, F] : never;

/** The decoded arguments of an event, typed from its ABI. */
export type EventArgs<C extends Config, N extends string> =
  Split<N> extends [infer K extends ContractName<C>, infer E extends string]
    ? AbiOf<C, K> extends Abi
      ? FindEvent<AbiOf<C, K>, E> extends infer Ev extends AbiEvent
        ? DecodedEventArgs<Ev>
        : never
      : never
    : never;

/** The decoded arguments of a call, typed from its ABI. */
export type CallArgs<C extends Config, N extends string> =
  SplitCall<N> extends [infer K extends ContractName<C>, infer F extends string]
    ? AbiOf<C, K> extends Abi
      ? F extends WriteFunctionName<AbiOf<C, K>>
        ? ContractFunctionArgs<AbiOf<C, K>, Mutability, F>
        : never
      : never
    : never;

/** The decoded result of a call, typed from its ABI. */
export type CallResult<C extends Config, N extends string> =
  SplitCall<N> extends [infer K extends ContractName<C>, infer F extends string]
    ? AbiOf<C, K> extends Abi
      ? F extends WriteFunctionName<AbiOf<C, K>>
        ? ContractFunctionReturnType<AbiOf<C, K>, Mutability, F>
        : never
      : never
    : never;

export interface BlockInfo {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestamp: bigint;
}

/** Always `hash` and `index`; the rest only with `includeTransaction: true`. */
export interface TransactionInfo {
  readonly hash: Hex;
  readonly index: number;
  readonly from?: Hex;
  readonly to?: Hex | null;
  readonly value?: bigint;
  readonly input?: Hex;
  readonly nonce?: number;
  readonly gas?: bigint;
  readonly gasPrice?: bigint | null;
  readonly maxFeePerGas?: bigint | null;
  readonly maxPriorityFeePerGas?: bigint | null;
  readonly type?: string;
}

/** Only with `includeReceipt: true`. */
export interface ReceiptInfo {
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly cumulativeGasUsed: bigint;
  readonly effectiveGasPrice: bigint | null;
  readonly contractAddress: Hex | null;
}

export interface IndexedEvent<TArgs = unknown> {
  /** `"Contract:Event"`, as registered. */
  readonly name: string;
  readonly args: TArgs;
  readonly log: {
    readonly address: Hex;
    readonly logIndex: number;
    readonly topics: readonly Hex[];
    readonly data: Hex;
  };
  readonly block: BlockInfo;
  readonly transaction: TransactionInfo;
  readonly receipt?: ReceiptInfo;
  /** Totally orders events across chains. */
  readonly checkpoint: string;
}

export interface CallEvent<TArgs = unknown, TResult = unknown> {
  /** `"Contract.fn()"`, as registered. */
  readonly name: string;
  readonly args: TArgs;
  readonly result: TResult;
  readonly trace: {
    readonly from: Hex;
    readonly to: Hex;
    readonly input: Hex;
    readonly output: Hex | null;
    readonly value: bigint;
    readonly gasUsed: bigint | null;
    /** Position in the transaction's call tree; [] is the top-level call. */
    readonly traceAddress: readonly number[];
  };
  readonly block: BlockInfo;
  readonly transaction: TransactionInfo;
  readonly checkpoint: string;
}

export interface BlockEvent {
  /** `"Name:block"`, as registered. */
  readonly name: string;
  readonly block: BlockInfo;
  readonly checkpoint: string;
}

/** Reads chain state at the block of the event being handled. */
export interface ContextClient {
  readContract(args: {
    address: Hex;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  call(args: { to: Hex; data: Hex }): Promise<Hex>;
  getBalance(address: Hex): Promise<bigint>;
  getCode(address: Hex): Promise<Hex>;
  getStorageAt(address: Hex, slot: Hex): Promise<Hex>;
}

export interface HandlerContext {
  readonly db: Db;
  readonly chain: { readonly id: number; readonly name: string };
  /** Pinned to the event's block. Reads at finalised blocks are cached, so a re-index makes no RPC calls. */
  readonly client: ContextClient;
  /** Side effects, delivered after the event's block is committed (and, by default, final). */
  readonly outbox: Outbox;
}

export type Handler<TArgs = unknown> = (args: {
  event: IndexedEvent<TArgs>;
  context: HandlerContext;
}) => Promise<void> | void;

export type CallHandler<TArgs = unknown, TResult = unknown> = (args: {
  event: CallEvent<TArgs, TResult>;
  context: HandlerContext;
}) => Promise<void> | void;

export type BlockHandler = (args: { event: BlockEvent; context: HandlerContext }) => Promise<void> | void;

/** Any registered handler; the engine passes each the event shape its name implies. */
export type AnyHandler = (args: { event: never; context: HandlerContext }) => Promise<void> | void;

/**
 * Where handlers are registered:
 *
 * - `"Contract:Event"` for logs, arguments typed from the ABI; for an overloaded event, the full
 *   signature, such as `"Emitter:Overloaded(uint256)"`;
 * - `"Contract.fn()"` for successful calls to a contract with `includeCallTraces: true`;
 * - `"Name:block"` for a block source.
 */
export class Tidemark<C extends Config = Config> {
  readonly config: C;
  readonly handlers = new Map<string, AnyHandler>();

  constructor(config: C) {
    this.config = config;
  }

  on<N extends EventName<C>>(name: N, handler: Handler<EventArgs<C, N>>): this;
  on<N extends CallName<C>>(name: N, handler: CallHandler<CallArgs<C, N>, CallResult<C, N>>): this;
  on(name: BlockName<C>, handler: BlockHandler): this;
  on(name: `${ContractName<C>}.${string}(${string})`, handler: CallHandler): this;
  on(name: string, handler: Handler<never> | CallHandler<never, never> | BlockHandler): this {
    if (this.handlers.has(name)) throw new Error(`a handler for ${name} is already registered`);
    this.handlers.set(name, handler as AnyHandler);
    return this;
  }
}

export const createTidemark = <const C extends Config>(config: C): Tidemark<C> => new Tidemark(config);
