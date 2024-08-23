# Stateless Viem Transport

This is a [custom transport](https://viem.sh/docs/clients/transports/custom.html) for [viem](https://viem.sh/) that allows you to use [Stateless'](https://www.stateless.solutions/) verifiable RPC endpoints.

## Installation

```bash
npm install stateless-viem-transport
```

## Usage

```typescript
import { createPublicClient, custom } from "viem";
import { mainnet } from "viem/chains";
import { createStatelessTransport } from "stateless-viem-transport";

const statelessTransport = createStatelessTransport({
  rpcUrl: "https://api.stateless.solutions/ethereum/v1/<YOUR_BUCKET_ID>",
  identities: ["https://<PROVIDER_IDENTITY>"],
});

const statelessClient = createPublicClient({
  chain: mainnet,
  transport: custom(statelessTransport),
});

console.log("Block Number:", await statelessClient.getBlockNumber());
```

## Light Clients

To use Stateless' light client mode, you can add an additional `proverUrl` parameter. This will enable the light client mode, which will verify the stateless proofs on the prover node.

Read more about the light client mode in the [Stateless docs](https://app.stateless.solutions/documentation/light-client).

```typescript
import { createStatelessTransport } from "stateless-viem-transport";

const statelessTransport = createStatelessTransport({
  rpcUrl: "https://<PROVIDER_RPC_URL>",
  identities: ["https://<PROVIDER_IDENTITY>"],
  proverUrl: "https://<PROVER_RPC_URL>", // enables light client mode
});

const statelessClient = createPublicClient({
  chain: mainnet,
  transport: custom(statelessTransport),
});

const contractAbi = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const contract = getContract({
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  abi: contractAbi,
  client: statelessClient,
});

console.log("USDC Total supply:", await contract.read.totalSupply());
```
