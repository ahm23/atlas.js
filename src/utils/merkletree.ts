import MerkleTree from "merkletreejs";
import { h_blake3 } from "./hash";

export async function buildMerkleTreeFromBlob(bytes: Blob, hashFn: any = h_blake3, chunkSize: number = 1024): Promise<MerkleTree> {
  const leaves: ArrayBuffer[] = []
  
  for (let i = 0; i < bytes.size; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize)
    const rawLeaf = await chunk.arrayBuffer()
    leaves.push(h_blake3(rawLeaf))
  }

  return new MerkleTree(leaves, hashFn)
}