import MerkleTree from "merkletreejs";
import { h_blake3 } from "./hash";

export async function buildFileMerkleTree(
  bytes: Blob, 
  hashFn: any = h_blake3, 
  chunkSize: number = 1024
): Promise<MerkleTree> {
  console.log("segmenting");
  console.time('SegmentFile');
  
  const leaves: Uint8Array[] = [];
  const stream = bytes.stream();
  const reader = stream.getReader();
  
  // Pre-allocate reusable chunks to avoid allocation in loop
  const chunkBuffer = new Uint8Array(chunkSize);
  let chunkPos = 0;
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (value) {
        let valuePos = 0;
        let valueRemaining = value.length;
        
        while (valueRemaining > 0) {
          const spaceInChunk = chunkSize - chunkPos;
          const toCopy = Math.min(spaceInChunk, valueRemaining);
          
          // Copy data into chunk buffer
          chunkBuffer.set(value.subarray(valuePos, valuePos + toCopy), chunkPos);
          chunkPos += toCopy;
          valuePos += toCopy;
          valueRemaining -= toCopy;
          
          // If chunk is full, process it
          if (chunkPos === chunkSize) {
            // IMPORTANT: Pass a copy to avoid mutation issues
            leaves.push(hashFn(new Uint8Array(chunkBuffer)));
            chunkPos = 0;
          }
        }
      }
      
      if (done) {
        // Handle final partial chunk
        if (chunkPos > 0) {
          leaves.push(hashFn(chunkBuffer.subarray(0, chunkPos)));
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
  console.log(leaves.length)
  return new MerkleTree(leaves, hashFn, { hashLeaves: false });
}