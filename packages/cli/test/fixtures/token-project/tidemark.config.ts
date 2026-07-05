import { tokenAbi } from "@tidemark/contracts";
import { defineConfig } from "@tidemark/engine";

export default defineConfig({
  chains: {
    anvil: { id: 31_337, rpc: process.env.ANVIL_RPC ?? "http://127.0.0.1:8545", finality: "tag" },
  },
  contracts: {
    Token: {
      chain: "anvil",
      abi: tokenAbi,
      address: (process.env.TOKEN_ADDRESS ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3") as `0x${string}`,
      startBlock: 0,
    },
  },
});
