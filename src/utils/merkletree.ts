import { MerkleTree } from "./atlas-merkletree";
import { h_blake3, h_xxh3 } from "./hash";

const LEAF_HASH_YIELD_INTERVAL = 8192;

export async function buildFileMerkleTree(
  bytes: Blob,
  signal: AbortSignal,
  chunkSize: number = 1024
): Promise<MerkleTree> {
  const startedAt = performance.now();
  const leafHashes: Uint8Array[] = [];
  const stream = bytes.stream();
  const reader = stream.getReader();
  const chunkBuffer = new Uint8Array(chunkSize);
  let chunkOffset = 0;
  let yieldCount = 0;

  console.debug(
    `[MerkleTree] Hashing ${bytes.size} bytes into ${chunkSize}-byte leaves`,
  );

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        let valueOffset = 0;

        while (valueOffset < value.length) {
          if (signal.aborted) throw new Error("Cancelled");

          const bytesToCopy = Math.min(chunkSize - chunkOffset, value.length - valueOffset);
          chunkBuffer.set(value.subarray(valueOffset, valueOffset + bytesToCopy), chunkOffset);
          chunkOffset += bytesToCopy;
          valueOffset += bytesToCopy;

          if (chunkOffset !== chunkSize) {
            continue;
          }

          leafHashes.push(h_blake3(chunkBuffer));
          chunkOffset = 0;

          if ((leafHashes.length & (LEAF_HASH_YIELD_INTERVAL - 1)) === 0) {
            yieldCount++;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      if (done) {
        if (chunkOffset > 0) {
          const finalHash = h_blake3(chunkBuffer.subarray(0, chunkOffset));
          leafHashes.push(finalHash);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const leafHashFinishedAt = performance.now();
  console.debug(
    `[MerkleTree] Hashed ${leafHashes.length} leaves in ${formatDuration(leafHashFinishedAt - startedAt)} (${yieldCount} yields)`,
  );

  const treeStartedAt = performance.now();
  const tree = new MerkleTree(leafHashes, h_xxh3, {
    buildLeafMap: false,
    domainSeparation: false,
    reuseHashInputBuffer: true,
    useXXH128: true,
  });
  console.debug(
    `[MerkleTree] Built ${tree.nodes.length} levels/${tree.leafCount} leaves in ${formatDuration(performance.now() - treeStartedAt)}`,
  );
  console.debug(
    `[MerkleTree] Total merkle time ${formatDuration(performance.now() - startedAt)}`,
  );

  return tree;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds.toFixed(1)}ms`
    : `${(milliseconds / 1000).toFixed(2)}s`;
}
