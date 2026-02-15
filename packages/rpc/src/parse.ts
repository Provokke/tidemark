import { InvalidResponseError } from "./errors.js";
import type { Hex, RpcBlockHeader, RpcLog, RpcReceipt, RpcTrace, RpcTransaction } from "./types.js";

const HEX = /^0x[0-9a-fA-F]*$/;

export function quantity(value: unknown, what: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new InvalidResponseError(`${what} is not a hex quantity`);
  }
  const n = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(n)) throw new InvalidResponseError(`${what} does not fit a safe integer`);
  return n;
}

function hex(value: unknown, what: string, bytes?: number): Hex {
  if (typeof value !== "string" || !HEX.test(value) || value.length % 2 !== 0) {
    throw new InvalidResponseError(`${what} is not hex data`);
  }
  if (bytes !== undefined && value.length !== 2 + bytes * 2) {
    throw new InvalidResponseError(`${what} is not ${bytes} bytes`);
  }
  return value.toLowerCase() as Hex;
}

export function parseLog(raw: unknown): RpcLog {
  if (typeof raw !== "object" || raw === null) throw new InvalidResponseError("log is not an object");
  const r = raw as Record<string, unknown>;
  if (r.removed === true) throw new InvalidResponseError("log is marked removed");
  if (!Array.isArray(r.topics) || r.topics.length > 4)
    throw new InvalidResponseError("log topics are malformed");
  return {
    blockNumber: quantity(r.blockNumber, "log.blockNumber"),
    blockHash: hex(r.blockHash, "log.blockHash", 32),
    transactionHash: hex(r.transactionHash, "log.transactionHash", 32),
    transactionIndex: quantity(r.transactionIndex, "log.transactionIndex"),
    logIndex: quantity(r.logIndex, "log.logIndex"),
    address: hex(r.address, "log.address", 20),
    topics: r.topics.map((t, i) => hex(t, `log.topics[${i}]`, 32)),
    data: hex(r.data, "log.data"),
  };
}

export function parseBlockHeader(raw: unknown): RpcBlockHeader {
  if (typeof raw !== "object" || raw === null) throw new InvalidResponseError("block is not an object");
  const r = raw as Record<string, unknown>;
  return {
    number: quantity(r.number, "block.number"),
    hash: hex(r.hash, "block.hash", 32),
    parentHash: hex(r.parentHash, "block.parentHash", 32),
    timestamp: quantity(r.timestamp, "block.timestamp"),
    logsBloom: hex(r.logsBloom, "block.logsBloom", 256),
    ...(r.receiptsRoot === undefined ? {} : { receiptsRoot: hex(r.receiptsRoot, "block.receiptsRoot", 32) }),
  };
}

export const toQuantity = (n: number): Hex => `0x${n.toString(16)}`;

function big(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new InvalidResponseError(`${what} is not a hex quantity`);
  return BigInt(value);
}

const optionalBig = (value: unknown, what: string): bigint | null =>
  value === undefined || value === null ? null : big(value, what);

const optionalHex = (value: unknown, what: string, bytes?: number): Hex | null =>
  value === undefined || value === null ? null : hex(value, what, bytes);

export function parseTrace(raw: unknown): RpcTrace {
  if (typeof raw !== "object" || raw === null) throw new InvalidResponseError("trace is not an object");
  const r = raw as Record<string, unknown>;
  const action = (r.action ?? {}) as Record<string, unknown>;
  const result = (r.result ?? null) as Record<string, unknown> | null;
  const type = typeof r.type === "string" ? r.type : "";
  if (!Array.isArray(r.traceAddress) || !r.traceAddress.every((n) => Number.isInteger(n))) {
    throw new InvalidResponseError("trace.traceAddress is malformed");
  }
  return {
    blockNumber:
      typeof r.blockNumber === "number" ? r.blockNumber : quantity(r.blockNumber, "trace.blockNumber"),
    blockHash: hex(r.blockHash, "trace.blockHash", 32),
    transactionHash: hex(r.transactionHash, "trace.transactionHash", 32),
    transactionIndex:
      typeof r.transactionPosition === "number"
        ? r.transactionPosition
        : quantity(r.transactionPosition, "trace.transactionPosition"),
    traceAddress: r.traceAddress as number[],
    type,
    callType: typeof action.callType === "string" ? action.callType : type,
    from: hex(action.from, "trace.action.from", 20),
    to:
      type === "call"
        ? hex(action.to, "trace.action.to", 20)
        : (optionalHex(result?.address, "trace.result.address", 20) ?? "0x"),
    input:
      type === "call"
        ? hex(action.input, "trace.action.input")
        : (optionalHex(action.init, "trace.action.init") ?? "0x"),
    output: result === null ? null : optionalHex(result.output, "trace.result.output"),
    value: action.value === undefined ? 0n : big(action.value, "trace.action.value"),
    gasUsed: result === null ? null : optionalBig(result.gasUsed, "trace.result.gasUsed"),
    error: typeof r.error === "string" ? r.error : null,
  };
}

export function parseTransaction(raw: unknown): RpcTransaction {
  if (typeof raw !== "object" || raw === null) throw new InvalidResponseError("transaction is not an object");
  const r = raw as Record<string, unknown>;
  return {
    hash: hex(r.hash, "tx.hash", 32),
    blockNumber: quantity(r.blockNumber, "tx.blockNumber"),
    blockHash: hex(r.blockHash, "tx.blockHash", 32),
    transactionIndex: quantity(r.transactionIndex, "tx.transactionIndex"),
    from: hex(r.from, "tx.from", 20),
    to: optionalHex(r.to, "tx.to", 20),
    value: big(r.value, "tx.value"),
    input: hex(r.input, "tx.input"),
    nonce: quantity(r.nonce, "tx.nonce"),
    gas: big(r.gas, "tx.gas"),
    gasPrice: optionalBig(r.gasPrice, "tx.gasPrice"),
    maxFeePerGas: optionalBig(r.maxFeePerGas, "tx.maxFeePerGas"),
    maxPriorityFeePerGas: optionalBig(r.maxPriorityFeePerGas, "tx.maxPriorityFeePerGas"),
    type: typeof r.type === "string" ? r.type : "0x0",
  };
}

export function parseReceipt(raw: unknown): RpcReceipt {
  if (typeof raw !== "object" || raw === null) throw new InvalidResponseError("receipt is not an object");
  const r = raw as Record<string, unknown>;
  return {
    transactionHash: hex(r.transactionHash, "receipt.transactionHash", 32),
    blockNumber: quantity(r.blockNumber, "receipt.blockNumber"),
    blockHash: hex(r.blockHash, "receipt.blockHash", 32),
    status: r.status === "0x1" ? "success" : "reverted",
    gasUsed: big(r.gasUsed, "receipt.gasUsed"),
    cumulativeGasUsed: big(r.cumulativeGasUsed, "receipt.cumulativeGasUsed"),
    effectiveGasPrice: optionalBig(r.effectiveGasPrice, "receipt.effectiveGasPrice"),
    contractAddress: optionalHex(r.contractAddress, "receipt.contractAddress", 20),
  };
}
