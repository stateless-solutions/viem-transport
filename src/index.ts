import crypto from "crypto";
import sshpk from "sshpk";
import nacl from "tweetnacl";
import { Trie } from "@ethereumjs/trie";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

type Attestation = {
  signature?: string;
  signatures?: string[];
  signatureFormat: string;
  hashAlgo: string;
  msg?: string;
  msgs?: string[];
  identity: string;
};

type AttestedJsonRpcResponse = JsonRpcResponse & {
  attestations: Array<Attestation>;
};

type AccessListItem = { address: string; storageKeys: Array<string> };

export class StatelessRpcClient {
  private rpcUrl: string;
  private identities: string[];
  private minimumRequiredAttestations: number;
  private proverUrl: string | null;

  constructor(
    rpcUrl: string,
    identities: string[],
    minimumRequiredAttestations: number = 1,
    proverUrl: string | null = null
  ) {
    this.rpcUrl = rpcUrl;
    this.identities = identities;
    this.minimumRequiredAttestations = minimumRequiredAttestations;
    this.proverUrl = proverUrl;
  }

  async request({
    method,
    params,
  }: {
    method: string;
    params: unknown[];
  }): Promise<unknown> {
    if (this.proverUrl && method === "eth_call") {
      await this.verifyStatelessProof(params);
    }

    const response = await sendJsonRpcRequest(this.rpcUrl, {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    });

    if (Array.isArray(response)) {
      throw new Error("Unexpected batch response for single request");
    }

    const attestedResponse = response as AttestedJsonRpcResponse;

    const isValid = await this.verifyAttestations(attestedResponse);

    if (!isValid) {
      throw new Error(
        `Request did not meet the attestation threshold of ${this.minimumRequiredAttestations}.`
      );
    }

    if (attestedResponse.error) {
      throw new RpcError(
        attestedResponse.error.message,
        attestedResponse.error.code,
        attestedResponse.error.data
      );
    }

    return attestedResponse.result;
  }

  private async verifyAttestations(
    response: AttestedJsonRpcResponse
  ): Promise<boolean> {
    const content = response.result ?? response.error;
    const contentHashes = this.hashContent(content);

    const validAttestations: Attestation[] = [];

    for (const [i, attestation] of response.attestations.entries()) {
      if (!attestation.identity) {
        attestation.identity = this.identities[i];
      }

      if (!this.identities.includes(attestation.identity)) {
        continue;
      }

      let sshPublicKey: string;
      try {
        sshPublicKey = await this.publicKeyFromIdentity(attestation.identity);
      } catch (error) {
        continue;
      }

      const key = sshpk.parseKey(sshPublicKey, "ssh");
      if (key.type !== "ed25519") {
        throw new Error("The provided key is not an ed25519 key");
      }

      // @ts-ignore
      const publicKeyUint8Array = new Uint8Array(key.part.A.data);

      const isValid = this.verifyAttestation(
        attestation,
        publicKeyUint8Array,
        contentHashes
      );

      if (isValid) {
        validAttestations.push(attestation);
      }
    }

    return validAttestations.length >= this.minimumRequiredAttestations;
  }

  private hashContent(content: unknown): string[] {
    if (Array.isArray(content)) {
      return content.map((item) => {
        const stringifiedItem = JSON.stringify(item);
        return crypto
          .createHash("sha256")
          .update(stringifiedItem)
          .digest("hex");
      });
    } else {
      const contentString = JSON.stringify(content);
      return [crypto.createHash("sha256").update(contentString).digest("hex")];
    }
  }

  private verifyAttestation(
    attestation: Attestation,
    publicKey: Uint8Array,
    contentHashes: string[]
  ): boolean {
    if (
      attestation.msgs &&
      attestation.msgs.length > 0 &&
      attestation.signatures
    ) {
      const isSubset = contentHashes.every((hash) =>
        attestation.msgs?.includes(hash)
      );
      if (!isSubset) {
        return false;
      }

      return attestation.msgs.every((msg, index) => {
        if (!attestation.signatures) return false;
        return this.verifySignature(
          msg,
          attestation.signatures[index],
          publicKey,
          attestation.hashAlgo
        );
      });
    } else if (attestation.msg && attestation.signature) {
      const isHashInResult = contentHashes.includes(attestation.msg);
      return (
        isHashInResult &&
        this.verifySignature(
          attestation.msg,
          attestation.signature,
          publicKey,
          attestation.hashAlgo
        )
      );
    }
    return false;
  }

  private verifySignature(
    msgHash: string,
    signature: string,
    publicKey: Uint8Array,
    hashAlgo: string
  ): boolean {
    try {
      const signatureBytes = Buffer.from(signature, "hex");
      const signatureUint8Array = new Uint8Array(signatureBytes);
      const msgHashBytes = Buffer.from(msgHash, "hex");

      return nacl.sign.detached.verify(
        msgHashBytes,
        signatureUint8Array,
        publicKey
      );
    } catch (error) {
      console.error("Verification failed:", error);
      return false;
    }
  }

  private async publicKeyFromIdentity(identity: string): Promise<string> {
    const url = `${identity}/.well-known/stateless-key`;
    const response = await fetch(url);

    if (response.status !== 200) {
      throw new Error(`Could not fetch public key from ${url}`);
    }

    return await response.text();
  }

  private async verifyStatelessProof(
    params: Array<any> | Record<string, any>
  ): Promise<void> {
    if (!this.proverUrl) {
      throw new Error("Prover URL is not set");
    }

    const latestBlockNumber = await this.sendToProver("eth_blockNumber", []);
    const { stateRoot: stateRootHex } = await this.sendToProver(
      "eth_getBlockByNumber",
      [latestBlockNumber, false]
    );
    const stateRoot = this.fromHexString(stateRootHex);

    let createAccessListParams: Record<string, any>;

    if (Array.isArray(params)) {
      const [firstParam] = params;
      createAccessListParams = this.extractDefinedProperties(firstParam);
    } else {
      createAccessListParams = this.extractDefinedProperties(params);
    }

    const { accessList }: { accessList: AccessListItem[] } =
      await this.sendToProver("eth_createAccessList", [createAccessListParams]);

    const {
      accountProof,
      storageProof,
      storageHash: storageHashHex,
    } = await this.sendToProver("eth_getProof", [
      accessList[0].address,
      accessList[0].storageKeys,
      latestBlockNumber,
    ]);

    const storageHash = this.fromHexString(storageHashHex);

    // Verify state trie
    const trie = new Trie({ root: stateRoot, useKeyHashing: true });
    await trie.updateFromProof(
      accountProof.map((p: string) => this.fromHexString(p))
    );

    const accessListAddress = this.fromHexString(accessList[0].address);
    const val = await trie.get(accessListAddress, true);

    if (!val) {
      throw new Error("Account not found in state trie");
    }

    // Verify storage trie
    const storageTrie = new Trie({ root: storageHash, useKeyHashing: true });

    for (let i = 0; i < accessList[0].storageKeys.length; i++) {
      const proofBuffer = storageProof[i].proof.map((p: string) =>
        this.fromHexString(p)
      );
      await storageTrie.updateFromProof(proofBuffer);
      const storageVal = await storageTrie.get(
        this.fromHexString(accessList[0].storageKeys[i])
      );

      if (!storageVal) {
        throw new Error("Storage value not found");
      }
    }
  }

  private async sendToProver(method: string, params: any[]): Promise<any> {
    if (!this.proverUrl) {
      throw new Error("Prover URL is not set");
    }

    const response = await sendJsonRpcRequest(this.proverUrl, {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    });

    if (Array.isArray(response)) {
      throw new Error("Unexpected batch response for single request to prover");
    }

    if (response.error) {
      throw new RpcError(
        response.error.message,
        response.error.code,
        response.error.data
      );
    }

    return response.result;
  }

  private extractDefinedProperties(
    obj: Record<string, any>
  ): Record<string, any> {
    return Object.fromEntries(
      Object.entries(obj).filter(([_, v]) => v !== undefined)
    );
  }

  private fromHexString(hexString: string): Uint8Array {
    if (hexString.startsWith("0x")) {
      hexString = hexString.slice(2);
    }
    return Uint8Array.from(
      (hexString.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16))
    );
  }
}

export interface StatelessClientConfig {
  rpcUrl: string;
  identities: string[];
  minimumRequiredAttestations?: number;
  proverUrl?: string;
}

export function createStatelessTransport(config: StatelessClientConfig) {
  const {
    rpcUrl,
    identities,
    minimumRequiredAttestations = 1,
    proverUrl = null,
  } = config;

  const client = new StatelessRpcClient(
    rpcUrl,
    identities,
    minimumRequiredAttestations,
    proverUrl
  );

  return {
    request: async function viemCompatibleRequest({
      method,
      params,
    }: {
      method: string;
      params: unknown[];
    }): Promise<unknown> {
      return client.request({ method, params });
    },
  };
}

async function sendJsonRpcRequest(
  url: string,
  request: JsonRpcRequest | JsonRpcRequest[]
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return response.json() as unknown as JsonRpcResponse | JsonRpcResponse[];
}
