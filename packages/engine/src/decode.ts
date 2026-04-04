import { type AbiEvent, type AbiFunction, type AbiParameter, decodeAbiParameters } from "viem";
import type { Hex } from "./config.js";

/** A log whose topics and data do not fit the event it was matched to. */
export class LogShapeError extends Error {
  override name = "LogShapeError";
}

type Decoder = (topics: readonly Hex[], data: Hex) => unknown;

const STATIC_ELEMENTARY =
  /^(address|bool|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes([1-9]|[12][0-9]|3[0-2]))$/;

const isStaticElementary = (type: string) => STATIC_ELEMENTARY.test(type);

const TWO_256 = 2n ** 256n;

/** Decodes one 32-byte word (64 hex characters) as a static elementary type. */
function wordDecoder(type: string): (word: string) => unknown {
  if (type === "address") {
    return (word) => {
      if (!word.startsWith("000000000000000000000000"))
        throw new LogShapeError("address word has dirty padding");
      return `0x${word.slice(24)}`;
    };
  }
  if (type === "bool") {
    return (word) => {
      const v = BigInt(`0x${word}`);
      if (v > 1n) throw new LogShapeError("bool word is neither 0 nor 1");
      return v === 1n;
    };
  }
  const fixedBytes = /^bytes(\d+)$/.exec(type);
  if (fixedBytes !== null) {
    const chars = Number(fixedBytes[1]) * 2;
    return (word) => {
      if (/[^0]/.test(word.slice(chars))) throw new LogShapeError(`${type} word has dirty padding`);
      return `0x${word.slice(0, chars)}`;
    };
  }
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int !== null) {
    const signed = int[1] === "";
    const bits = int[2] === "" || int[2] === undefined ? 256 : Number(int[2]);
    const asNumber = bits <= 48; // viem's convention: small integers decode to number
    const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
    const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
    return (word) => {
      let v = BigInt(`0x${word}`);
      if (signed && v >= TWO_256 / 2n) v -= TWO_256;
      if (v < min || v > max) throw new LogShapeError(`${type} value out of range`);
      return asNumber ? Number(v) : v;
    };
  }
  throw new Error(`not a static elementary type: ${type}`);
}

/** Lowercases every address in a value decoded by viem, which checksums them. */
function lowercaser(param: AbiParameter): ((value: unknown) => unknown) | undefined {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    const inner = lowercaser({ ...param, type: array[1] ?? "" } as AbiParameter);
    return inner === undefined ? undefined : (value) => (value as unknown[]).map(inner);
  }
  if (param.type === "address") return (value) => (value as string).toLowerCase();
  if (param.type === "tuple" && "components" in param) {
    const parts = param.components.map((c, i) => [c.name ?? String(i), lowercaser(c)] as const);
    if (parts.every(([, f]) => f === undefined)) return undefined;
    const named = param.components.every((c) => c.name !== undefined && c.name !== "");
    return (value) => {
      if (named) {
        const out = { ...(value as Record<string, unknown>) };
        for (const [key, f] of parts) if (f !== undefined) out[key] = f(out[key]);
        return out;
      }
      return (value as unknown[]).map((v, i) => parts[i]?.[1]?.(v) ?? v);
    };
  }
  return undefined;
}

/**
 * Compiles a decoder for one event. Arguments come back with viem's shapes (an object keyed by
 * name when every input is named, else an array; integers of 48 bits or fewer as numbers) except
 * that addresses are lowercase, the form Tidemark stores and compares hex in. Indexed dynamic
 * values (strings, bytes, arrays, tuples) decode to the hash the EVM stores in their topic.
 *
 * Events whose non-indexed inputs are all static elementary types, most events in practice, are
 * decoded straight from the 32-byte words; others go through viem's parameter decoder.
 */
export function compileEventDecoder(item: AbiEvent): Decoder {
  const inputs = item.inputs;
  const indexed = inputs.filter((i) => i.indexed === true);
  const nonIndexed = inputs.filter((i) => i.indexed !== true);
  const expectedTopics = 1 + indexed.length;
  const named = inputs.length > 0 && inputs.every((i) => i.name !== undefined && i.name !== "");

  const topicDecoders = indexed.map((i) =>
    isStaticElementary(i.type) ? wordDecoder(i.type) : (word: string) => `0x${word}`,
  );
  const fast = nonIndexed.every((i) => isStaticElementary(i.type));
  const dataWords = nonIndexed.map((i) => (fast ? wordDecoder(i.type) : undefined));
  const fixups = nonIndexed.map((i) => lowercaser(i));
  const dataLength = 2 + 64 * nonIndexed.length;

  return (topics, data) => {
    if (topics.length !== expectedTopics) {
      throw new LogShapeError(`expected ${expectedTopics} topics, got ${topics.length}`);
    }
    const indexedValues = topicDecoders.map((decode, k) => decode((topics[k + 1] ?? "").slice(2)));
    let dataValues: unknown[];
    if (fast) {
      if (data.length !== dataLength) throw new LogShapeError(`expected ${nonIndexed.length} data words`);
      dataValues = dataWords.map((decode, k) => decode?.(data.slice(2 + 64 * k, 66 + 64 * k)));
    } else {
      try {
        dataValues = [...decodeAbiParameters(nonIndexed, data)];
      } catch (error) {
        throw new LogShapeError("data does not decode", { cause: error });
      }
      dataValues = dataValues.map((v, k) => fixups[k]?.(v) ?? v);
    }

    // viem's shape for an event without inputs.
    if (inputs.length === 0) return undefined;
    let ii = 0;
    let di = 0;
    const ordered = inputs.map((input) => (input.indexed === true ? indexedValues[ii++] : dataValues[di++]));
    if (!named) return ordered;
    const args: Record<string, unknown> = {};
    inputs.forEach((input, k) => {
      args[input.name as string] = ordered[k];
    });
    return args;
  };
}

/**
 * Compiles decoders for a function's input (without its 4-byte selector) and output. Same shapes
 * as the event decoder: named object when every parameter is named, else an array (viem's
 * convention for function arguments is an array, which is what is returned for `args`); a single
 * output is returned bare, several as an array; addresses lowercase.
 */
export function compileFunctionDecoder(item: AbiFunction): {
  args: (input: Hex) => readonly unknown[];
  result: (output: Hex | null) => unknown;
} {
  const inFix = item.inputs.map((p) => lowercaser(p));
  const outFix = item.outputs.map((p) => lowercaser(p));
  return {
    args: (input) => {
      try {
        const values = decodeAbiParameters(item.inputs, `0x${input.slice(10)}`);
        return values.map((v, i) => inFix[i]?.(v) ?? v);
      } catch (error) {
        throw new LogShapeError("call input does not decode", { cause: error });
      }
    },
    result: (output) => {
      if (output === null || output === "0x" || item.outputs.length === 0) return undefined;
      try {
        const values = decodeAbiParameters(item.outputs, output).map((v, i) => outFix[i]?.(v) ?? v);
        return values.length === 1 ? values[0] : values;
      } catch (error) {
        throw new LogShapeError("call output does not decode", { cause: error });
      }
    },
  };
}
