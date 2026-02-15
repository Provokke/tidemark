export type Hex = `0x${string}`;

/** A log as Tidemark stores it: numbers decoded, addresses lowercased. */
export interface RpcLog {
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface RpcBlockHeader {
  readonly number: number;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: number;
  readonly logsBloom: Hex;
  /** Present on every chain since the Frontier release; optional only for hand-made headers. */
  readonly receiptsRoot?: Hex;
}

export type BlockTag = "latest" | "safe" | "finalized" | "earliest" | "pending";

export interface JsonRpcRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

/** A call from `trace_filter` / `trace_block` (OpenEthereum-style traces). */
export interface RpcTrace {
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly transactionIndex: number;
  /** Position in the call tree: [] for the top-level call, [0] for its first subcall, and so on. */
  readonly traceAddress: readonly number[];
  readonly type: string;
  readonly callType: string;
  readonly from: Hex;
  readonly to: Hex;
  readonly input: Hex;
  readonly output: Hex | null;
  readonly value: bigint;
  readonly gasUsed: bigint | null;
  readonly error: string | null;
}

export interface RpcTransaction {
  readonly hash: Hex;
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly transactionIndex: number;
  readonly from: Hex;
  readonly to: Hex | null;
  readonly value: bigint;
  readonly input: Hex;
  readonly nonce: number;
  readonly gas: bigint;
  readonly gasPrice: bigint | null;
  readonly maxFeePerGas: bigint | null;
  readonly maxPriorityFeePerGas: bigint | null;
  readonly type: string;
}

export interface RpcReceipt {
  readonly transactionHash: Hex;
  readonly blockNumber: number;
  readonly blockHash: Hex;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly cumulativeGasUsed: bigint;
  readonly effectiveGasPrice: bigint | null;
  readonly contractAddress: Hex | null;
}
