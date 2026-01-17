import MerkleTree from "merkletreejs";
import { h_blake3 } from "./hash";
import { CancellationException } from "@/storage";

export async function buildFileMerkleTree(
  bytes: Blob,
  signal: AbortSignal,
  hashFn: any = h_blake3, 
  chunkSize: number = 1024
): Promise<MerkleTree> {
  console.log("segmenting");
  console.time('SegmentFile');
  
  const leaves: Uint8Array[] = [];
  const stream = bytes.stream();
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (value) {
        // Append new data to buffer
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;
      }
      
      // Process complete chunks from buffer
      while (buffer.length >= chunkSize) {
        if (signal.aborted) throw new CancellationException('Merkling cancelled')
        // Use subarray to avoid copying
        leaves.push(h_blake3(buffer.subarray(0, chunkSize)));
        // Remove processed chunk from buffer
        buffer = buffer.subarray(chunkSize);
      }
      
      if (done) {
        // Handle final partial chunk
        if (buffer.length > 0) {
          leaves.push(buffer);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  console.timeEnd('SegmentFile');
  console.log("segmenting done");
  console.time('MerkleFile');
  return new MerkleTree(leaves, hashFn);
}