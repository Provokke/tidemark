/** Handler argument types, checked by the compiler (`tsc --noEmit` runs over tests). */
import { emitterAbi } from "@tidemark/contracts";
import { describe, expectTypeOf, it } from "vitest";
import { type EventArgs, type EventName, defineConfig } from "../src/index.js";

const _config = defineConfig({
  chains: { anvil: { id: 31_337, rpc: "http://127.0.0.1:8545", finality: "tag" } },
  contracts: {
    Emitter: {
      chain: "anvil",
      abi: emitterAbi,
      address: "0x0000000000000000000000000000000000000001",
      startBlock: 0,
    },
  },
});
type C = typeof _config;
type Hex = `0x${string}`;

describe("handler types", () => {
  it("names events by name, or by signature when overloaded; never anonymous ones", () => {
    expectTypeOf<"Emitter:Simple">().toExtend<EventName<C>>();
    expectTypeOf<"Emitter:Simple(address,address,uint256)">().toExtend<EventName<C>>();
    expectTypeOf<"Emitter:Overloaded(uint256)">().toExtend<EventName<C>>();
    expectTypeOf<"Emitter:Tuple((uint256,address),((uint256,address),(uint256,address)[],string))">().toExtend<
      EventName<C>
    >();
    expectTypeOf<"Emitter:Overloaded">().not.toExtend<EventName<C>>();
    expectTypeOf<"Emitter:AnonymousFour">().not.toExtend<EventName<C>>();
    expectTypeOf<"Emitter:Nope">().not.toExtend<EventName<C>>();
  });

  it("types arguments as the decoder returns them", () => {
    expectTypeOf<EventArgs<C, "Emitter:Simple">>().toEqualTypeOf<{
      readonly from: Hex;
      readonly to: Hex;
      readonly value: bigint;
    }>();
    expectTypeOf<EventArgs<C, "Emitter:Overloaded(address)">>().toEqualTypeOf<{ readonly value: Hex }>();
    expectTypeOf<EventArgs<C, "Emitter:Overloaded(uint256)">>().toEqualTypeOf<{ readonly value: bigint }>();
    // Integers up to 48 bits are numbers, as viem decodes them.
    expectTypeOf<EventArgs<C, "Emitter:AllStatic">["a"]>().toEqualTypeOf<number>();
    expectTypeOf<EventArgs<C, "Emitter:AllStatic">["b"]>().toEqualTypeOf<bigint>();
    // Indexed dynamic values are only their hash in the log.
    expectTypeOf<EventArgs<C, "Emitter:IndexedDynamic">>().toEqualTypeOf<{
      readonly s: Hex;
      readonly b: Hex;
      readonly arr: Hex;
    }>();
    expectTypeOf<EventArgs<C, "Emitter:IndexedTuple">["p"]>().toEqualTypeOf<Hex>();
    expectTypeOf<EventArgs<C, "Emitter:IndexedStatic">["a"]>().toEqualTypeOf<bigint>();
    expectTypeOf<EventArgs<C, "Emitter:Tuple">["p"]>().toEqualTypeOf<{ x: bigint; y: Hex }>();
  });
});
