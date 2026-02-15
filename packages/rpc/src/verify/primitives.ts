import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Hex } from "../types.js";

export type Bytes = Uint8Array;
/** What RLP encodes: byte strings and lists of them, nested. */
export type RlpItem = Bytes | readonly RlpItem[];

export const keccak = (data: Bytes): Bytes => keccak_256(data);

export function hexToBytes(hex: string): Bytes {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean))
    throw new TypeError(`not hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes: Bytes): Hex => `0x${Buffer.from(bytes).toString("hex")}`;

/** An unsigned integer (a quantity) as minimal big-endian bytes; zero is empty. */
export function quantityToBytes(quantity: string | bigint | number): Bytes {
  let n = BigInt(quantity);
  if (n < 0n) throw new RangeError("negative quantity");
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from(out);
}

function concat(parts: readonly Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function lengthPrefix(length: number, short: number, long: number): Bytes {
  if (length <= 55) return Uint8Array.of(short + length);
  const len = quantityToBytes(length);
  return concat([Uint8Array.of(long + len.length), len]);
}

/** Recursive Length Prefix encoding (Ethereum yellow paper, appendix B). */
export function rlp(item: RlpItem): Bytes {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] as number) < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80, 0xb7), item]);
  }
  const payload = concat((item as readonly RlpItem[]).map(rlp));
  return concat([lengthPrefix(payload.length, 0xc0, 0xf7), payload]);
}

// ---------------------------------------------------------------- Merkle Patricia trie

type Node = readonly RlpItem[];

function nibbles(bytes: Bytes): number[] {
  const out: number[] = [];
  for (const b of bytes) out.push(b >> 4, b & 0x0f);
  return out;
}

/** Hex-prefix encoding of a nibble path (yellow paper, appendix C). */
function hexPrefix(path: readonly number[], leaf: boolean): Bytes {
  const flag = (leaf ? 2 : 0) + (path.length % 2);
  const all = path.length % 2 === 1 ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(all.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = ((all[i * 2] as number) << 4) | (all[i * 2 + 1] as number);
  return out;
}

/** A child reference: the node itself when its encoding is under 32 bytes, else its hash. */
function ref(node: Node): RlpItem {
  const encoded = rlp(node);
  return encoded.length < 32 ? node : keccak(encoded);
}

function build(items: readonly { path: number[]; value: Bytes }[], depth: number): Node {
  if (items.length === 1) {
    const only = items[0] as { path: number[]; value: Bytes };
    return [hexPrefix(only.path.slice(depth), true), only.value];
  }
  // The longest path segment every item shares below `depth`: an extension node.
  let shared = 0;
  const first = items[0]?.path ?? [];
  for (;;) {
    const at = depth + shared;
    if (items.some((it) => it.path.length <= at) || items.some((it) => it.path[at] !== first[at])) break;
    shared++;
  }
  if (shared > 0)
    return [hexPrefix(first.slice(depth, depth + shared), false), ref(build(items, depth + shared))];
  const branch: RlpItem[] = Array.from({ length: 17 }, () => new Uint8Array(0));
  for (let n = 0; n < 16; n++) {
    const group = items.filter((it) => it.path.length > depth && it.path[depth] === n);
    if (group.length > 0) branch[n] = ref(build(group, depth + 1));
  }
  const here = items.find((it) => it.path.length === depth);
  if (here !== undefined) branch[16] = here.value;
  return branch;
}

/** The root of a trie holding `values[i]` under the key `rlp(i)`: transactions and receipts roots. */
export function orderedTrieRoot(values: readonly Bytes[]): Hex {
  if (values.length === 0) return bytesToHex(keccak(rlp(new Uint8Array(0))));
  const items = values.map((value, i) => ({ path: nibbles(rlp(quantityToBytes(i))), value }));
  return bytesToHex(keccak(rlp(build(items, 0))));
}

// ---------------------------------------------------------------- receipts and blooms

/** A receipt as `eth_getBlockReceipts` returns it (the fields the encoding uses). */
export interface RawReceipt {
  readonly type?: string;
  readonly status?: string;
  /** Pre-Byzantium receipts carry a state root instead of a status; some nodes send null. */
  readonly root?: string | null;
  readonly cumulativeGasUsed: string;
  readonly logsBloom: string;
  readonly logs: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
  /** OP-stack deposit receipts (type 0x7e), from Canyon. */
  readonly depositNonce?: string;
  readonly depositReceiptVersion?: string;
}

/** A receipt's consensus encoding: `rlp([status|root, cumulativeGas, bloom, logs])`, typed ones prefixed by their type. */
export function encodeReceipt(receipt: RawReceipt): Bytes {
  const outcome =
    receipt.root !== undefined && receipt.root !== null && receipt.status === undefined
      ? hexToBytes(receipt.root)
      : quantityToBytes(receipt.status ?? "0x0");
  const fields: RlpItem[] = [
    outcome,
    quantityToBytes(receipt.cumulativeGasUsed),
    hexToBytes(receipt.logsBloom),
    receipt.logs.map((log) => [hexToBytes(log.address), log.topics.map(hexToBytes), hexToBytes(log.data)]),
  ];
  const type = Number(receipt.type ?? "0x0");
  if (type === 0x7e && receipt.depositNonce !== undefined) {
    fields.push(quantityToBytes(receipt.depositNonce));
    if (receipt.depositReceiptVersion !== undefined)
      fields.push(quantityToBytes(receipt.depositReceiptVersion));
  }
  const body = rlp(fields);
  return type === 0 ? body : concat([Uint8Array.of(type), body]);
}

/** The bloom bits of one value: three 11-bit slices of its keccak (yellow paper, 4.3.1). */
function bloomBits(value: Bytes): [number, number][] {
  const h = keccak(value);
  return [0, 2, 4].map((i) => {
    const bit = (((h[i] as number) << 8) | (h[i + 1] as number)) & 2047;
    return [255 - Math.floor(bit / 8), 1 << (bit % 8)];
  });
}

/** The 2048-bit bloom of a set of logs: each address and topic sets three bits. */
export function logsBloom(
  logs: readonly { readonly address: string; readonly topics: readonly string[] }[],
): Hex {
  const bloom = new Uint8Array(256);
  for (const log of logs) {
    for (const value of [log.address, ...log.topics]) {
      for (const [byte, mask] of bloomBits(hexToBytes(value))) bloom[byte] = (bloom[byte] as number) | mask;
    }
  }
  return bytesToHex(bloom);
}

/** Whether a bloom may contain a value (false: certainly not). */
export function bloomMayContain(bloom: Hex, value: string): boolean {
  const bits = hexToBytes(bloom);
  return bloomBits(hexToBytes(value)).every(([byte, mask]) => ((bits[byte] as number) & mask) !== 0);
}
