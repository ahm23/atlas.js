// merkletree.ts

export type HashFunction = (data: Uint8Array) => Uint8Array | bigint;

export interface MerkleProof {
  siblings: Uint8Array[];
  index: number;
  path: number; // Bit path indicating left/right positions
}

export class MerkleTree {
  private readonly hashFunc: HashFunction;
  private readonly domainSeparation: boolean;
  private readonly useXXH128: boolean;
  
  public readonly leaves: Uint8Array[];
  public readonly leafMap: Map<string, number>;
  public readonly nodes: Uint8Array[][];
  public readonly root: Uint8Array;
  public readonly depth: number;
  public readonly leafCount: number;

  constructor(
    input: Uint8Array[],
    hashFunc: HashFunction,
    options: {
      domainSeparation?: boolean;
      useXXH128?: boolean;
    } = {}
  ) {
    if (input.length === 0) {
      throw new Error("Invalid number of leaves");
    }

    this.hashFunc = hashFunc;
    this.domainSeparation = options.domainSeparation ?? false;
    this.useXXH128 = options.useXXH128 ?? true;
    this.leafCount = input.length;
    this.leafMap = new Map();

    // Compute leaves with domain separation if enabled
    this.leaves = this.computeLeafNodes(input);
    
    // Build the tree
    const result = this.grow();
    this.nodes = result.nodes;
    this.root = result.root;
    this.depth = result.depth;
  }

  private computeLeafNodes(input: Uint8Array[]): Uint8Array[] {
    const leaves: Uint8Array[] = [];
    
    for (let i = 0; i < input.length; i++) {
      const leaf = this.sproutLeaf(input[i]);
      leaves.push(leaf);
      this.leafMap.set(bytesToHex(leaf), i);
    }
    
    return leaves;
  }

  private sproutLeaf(data: Uint8Array): Uint8Array {
    let input: Uint8Array;
    
    if (this.domainSeparation) {
      input = new Uint8Array(1 + data.length);
      input[0] = 0x00; // leafPrefix
      input.set(data, 1);
    } else {
      input = data;
    }
    
    return this.normalizeHash(this.hashFunc(input));
  }

  private grow(): { nodes: Uint8Array[][]; root: Uint8Array; depth: number } {
    const nodes: Uint8Array[][] = [];
    let level: Uint8Array[] = [...this.leaves];

    while (level.length > 1) {
      nodes.push(level);
      
      const nextLevelSize = (level.length + 1) >> 1;
      const nextLevel: Uint8Array[] = new Array(nextLevelSize);

      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 === level.length) {
          // Odd node: carry up
          nextLevel[i >> 1] = level[i];
        } else {
          // Normal pair: hash together
          const left = level[i];
          const right = level[i + 1];
          
          let raw: Uint8Array;
          if (this.domainSeparation) {
            raw = new Uint8Array(1 + left.length + right.length);
            raw[0] = 0x01; // nodePrefix
            raw.set(left, 1);
            raw.set(right, 1 + left.length);
          } else {
            raw = new Uint8Array(left.length + right.length);
            raw.set(left);
            raw.set(right, left.length);
          }
          
          nextLevel[i >> 1] = this.normalizeHash(this.hashFunc(raw));
        }
      }

      level = nextLevel;
    }

    nodes.push(level); // Add root level
    
    return {
      nodes,
      root: level[0],
      depth: nodes.length,
    };
  }

  private normalizeHash(hash: Uint8Array | bigint): Uint8Array {
    if (hash instanceof Uint8Array) {
      return hash;
    }
    
    // Convert bigint to bytes (XXH128 = 16 bytes, XXH64 = 8 bytes)
    const byteLength = this.useXXH128 ? 16 : 8;
    const bytes = new Uint8Array(byteLength);
    let v = hash;
    for (let i = byteLength - 1; i >= 0; i--) {
      bytes[i] = Number(v & 0xFFn);
      v >>= 8n;
    }
    return bytes;
  }

  public generateProof(leafData: Uint8Array): MerkleProof {
    const leaf = this.sproutLeaf(leafData);
    const leafHex = bytesToHex(leaf);
    const index = this.leafMap.get(leafHex);
    
    if (index === undefined) {
      throw new Error("Leaf not found in tree");
    }

    return this.generateProofByIndex(index);
  }

  public generateProofByIndex(index: number): MerkleProof {
    if (this.leafCount === 1) {
      return {
        siblings: [],
        index: 0,
        path: 0,
      };
    }

    const siblings: Uint8Array[] = [];
    let currentIdx = index;
    let path = 0;
    let siblingBit = 0;

    for (let level = 0; level < this.depth - 1; level++) {
      const levelNodes = this.nodes[level];
      const isRightChild = (currentIdx & 1) === 1;
      
      let siblingIdx: number;
      if (isRightChild) {
        siblingIdx = currentIdx - 1;
      } else {
        siblingIdx = currentIdx + 1;
      }

      if (siblingIdx >= 0 && siblingIdx < levelNodes.length) {
        siblings.push(levelNodes[siblingIdx]);
        if (isRightChild) {
          path |= (1 << siblingBit);
        }
        siblingBit++;
      }

      currentIdx >>= 1;
    }

    // Handle final level if needed
    const topLevel = this.nodes[this.depth - 1];
    if (topLevel.length === 2) {
      const siblingIdx = currentIdx === 0 ? 1 : 0;
      siblings.push(topLevel[siblingIdx]);
      if (currentIdx === 1) {
        path |= (1 << siblingBit);
      }
    }

    return {
      siblings,
      index,
      path,
    };
  }

  public verifyProof(leafData: Uint8Array, proof: MerkleProof): boolean {
    const leaf = this.sproutLeaf(leafData);
    return verifyMerkleProof(leaf, this.root, proof, this.hashFunc, {
      domainSeparation: this.domainSeparation,
      useXXH128: this.useXXH128,
    });
  }
}

// Standalone verification function (matches Go's Verify)
export function verifyMerkleProof(
  leaf: Uint8Array,
  root: Uint8Array,
  proof: MerkleProof,
  hashFunc: HashFunction,
  options: {
    domainSeparation?: boolean;
    useXXH128?: boolean;
  } = {}
): boolean {
  const domainSeparation = options.domainSeparation ?? false;
  const useXXH128 = options.useXXH128 ?? true;

  if (proof.siblings.length === 0) {
    return bytesEqual(leaf, root);
  }

  let result = leaf;
  let path = proof.path;

  for (const sibling of proof.siblings) {
    let combined: Uint8Array;
    const isRightChild = (path & 1) === 1;

    if (domainSeparation) {
      combined = new Uint8Array(1 + sibling.length + result.length);
      combined[0] = 0x01; // nodePrefix
      
      if (isRightChild) {
        combined.set(sibling, 1);
        combined.set(result, 1 + sibling.length);
      } else {
        combined.set(result, 1);
        combined.set(sibling, 1 + result.length);
      }
    } else {
      combined = new Uint8Array(sibling.length + result.length);
      
      if (isRightChild) {
        combined.set(sibling);
        combined.set(result, sibling.length);
      } else {
        combined.set(result);
        combined.set(sibling, result.length);
      }
    }

    const hash = hashFunc(combined);
    
    // Normalize hash
    if (hash instanceof Uint8Array) {
      result = hash;
    } else {
      const byteLength = useXXH128 ? 16 : 8;
      result = new Uint8Array(byteLength);
      let v = hash;
      for (let i = byteLength - 1; i >= 0; i--) {
        result[i] = Number(v & 0xFFn);
        v >>= 8n;
      }
    }

    path >>= 1;
  }

  return bytesEqual(result, root);
}

// Utility functions
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}