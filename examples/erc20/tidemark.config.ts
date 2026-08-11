import { defineConfig } from "@tidemark/engine";
import { erc20Abi } from "./abis/ERC20";

export default defineConfig({
  chains: {
    mainnet: { id: 1, rpc: process.env.MAINNET_RPC_URL ?? "", finality: "tag" },
  },
  contracts: {
    Token: {
      chain: "mainnet",
      abi: erc20Abi,
      address: (process.env.TOKEN_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      startBlock: 0,
    },
  },
});
