import { MerkleTree, bytesToHex } from "./atlas-merkletree";
import { h_blake3, h_xxh3 } from "./hash";

export async function buildFileMerkleTree(
  bytes: Blob,
  signal: AbortSignal,
  chunkSize: number = 1024
): Promise<MerkleTree> {
  const leafHashes: Uint8Array[] = [];
  const stream = bytes.stream();
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;
      }

      while (buffer.length >= chunkSize) {
        if (signal.aborted) throw new Error("Cancelled");

        const chunkHash = h_blake3(buffer.subarray(0, chunkSize));
        leafHashes.push(chunkHash);
        buffer = buffer.subarray(chunkSize);

        if (leafHashes.length % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      if (done) {
        if (buffer.length > 0) {
          const finalHash = h_blake3(buffer);
          leafHashes.push(finalHash);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return new MerkleTree(leafHashes, h_xxh3, {
    domainSeparation: false,
    useXXH128: true,
  });
}