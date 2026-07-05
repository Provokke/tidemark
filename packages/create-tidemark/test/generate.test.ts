import { emitterAbi } from "@tidemark/contracts";
import type { Abi } from "viem";
import { describe, expect, it } from "vitest";
import { columnKind, erc20Template, generateProject } from "../src/index.js";

const param = (type: string) => ({ type, name: "x" });

describe("columnKind", () => {
  it("maps ABI types to columns that hold every value", () => {
    expect(columnKind(param("address"), false)).toBe("hex");
    expect(columnKind(param("bytes32"), false)).toBe("hex");
    expect(columnKind(param("bytes"), false)).toBe("hex");
    expect(columnKind(param("bool"), false)).toBe("boolean");
    expect(columnKind(param("string"), false)).toBe("text");
    // int4 holds int32 and uint16, not uint32.
    expect(columnKind(param("uint16"), false)).toBe("integer");
    expect(columnKind(param("uint32"), false)).toBe("bigint");
    expect(columnKind(param("int32"), false)).toBe("integer");
    expect(columnKind(param("int64"), false)).toBe("bigint");
    expect(columnKind(param("uint256"), false)).toBe("bigint");
    expect(columnKind(param("uint256[]"), false)).toBe("json");
    expect(columnKind(param("address[3]"), false)).toBe("json");
    expect(columnKind(param("tuple"), false)).toBe("json");
  });

  it("stores indexed dynamic values as the hash the log holds", () => {
    expect(columnKind(param("string"), true)).toBe("hex");
    expect(columnKind(param("uint256[]"), true)).toBe("hex");
    expect(columnKind(param("tuple"), true)).toBe("hex");
    expect(columnKind(param("uint256"), true)).toBe("bigint");
  });
});

describe("generateProject", () => {
  const generate = (abi: Abi) =>
    generateProject({
      name: "p",
      chain: { name: "mainnet", id: 1, rpcEnv: "MAINNET_RPC_URL" },
      contracts: [
        { name: "Emitter", abi, address: "0x0000000000000000000000000000000000000001", startBlock: 0 },
      ],
      tidemarkVersion: "^0.1.0",
    });

  it("names overloaded events by signature and skips anonymous ones", () => {
    const { files, skipped } = generate(emitterAbi as Abi);
    const handlers = files.find((f) => f.path === "src/index.ts")?.content ?? "";
    expect(handlers).toContain('tidemark.on("Emitter:Overloaded(uint256)"');
    expect(handlers).toContain('tidemark.on("Emitter:Overloaded(address)"');
    expect(handlers).toContain('tidemark.on("Emitter:Simple"');
    expect(skipped).toEqual([expect.stringContaining("Emitter:AnonymousFour")]);
    const schema = files.find((f) => f.path === "tidemark.schema.ts")?.content ?? "";
    expect(schema).toContain('onchainTable("emitter_overloaded_uint256"');
    expect(schema).toContain('onchainTable("emitter_overloaded_address"');
  });

  it("renames arguments that clash with its own columns or are unnamed", () => {
    const abi: Abi = [
      {
        type: "event",
        name: "Weird",
        inputs: [
          { name: "id", type: "uint256", indexed: false },
          { name: "", type: "address", indexed: true },
          { name: "default", type: "bool", indexed: false },
          { name: "timestamp", type: "uint64", indexed: false },
        ],
      },
    ];
    const handlers = generate(abi).files.find((f) => f.path === "src/index.ts")?.content ?? "";
    expect(handlers).toContain("id_: event.args.id,");
    expect(handlers).toContain("arg1: event.args[1],");
    expect(handlers).toContain("default_: event.args.default,");
    expect(handlers).toContain("timestamp_: event.args.timestamp,");
    expect(handlers).toContain("timestamp: event.block.timestamp,");
  });

  it("installs every type package its tsconfig asks for", () => {
    for (const files of [
      generate(emitterAbi as Abi).files,
      erc20Template({
        name: "t",
        chain: { name: "mainnet", id: 1, rpcEnv: "MAINNET_RPC_URL" },
        tidemarkVersion: "^1.0.0",
        address: "0x0000000000000000000000000000000000000001",
        startBlock: 0,
      }),
    ]) {
      const pkg = JSON.parse(files.find((f) => f.path === "package.json")?.content ?? "{}") as {
        devDependencies: Record<string, string>;
      };
      const tsconfig = JSON.parse(files.find((f) => f.path === "tsconfig.json")?.content ?? "{}") as {
        compilerOptions: { types?: string[] };
      };
      for (const t of tsconfig.compilerOptions.types ?? [])
        expect(pkg.devDependencies).toHaveProperty(`@types/${t}`);
    }
  });
});
