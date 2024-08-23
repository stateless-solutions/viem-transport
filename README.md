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
