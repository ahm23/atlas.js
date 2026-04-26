// merkletree.ts

export type HashFunction = (data: Uint8Array) => Uint8Array | bigint;

interface MerkleTreeOptions {
  buildLeafMap?: boolean;
  domainSeparation?: boolean;
  reuseHashInputBuffer?: boolean;
  useXXH128?: boolean;
}

export interface MerkleProof {
  siblings: Uint8Array[];
  index: number;
  path: number; // Bit path indicating left/right positions
}

export class MerkleTree {
  private readonly hashFunc: HashFunction;
  private readonly buildLeafMapOnInit: boolean;
  private readonly domainSeparation: boolean;
  private readonly reuseHashInputBuffer: boolean;
  private readonly useXXH128: boolean;
  private leafMapReady: boolean;
  
  public readonly leaves: Uint8Array[];
  public readonly leafMap: Map<string, number>;
  public readonly nodes: Uint8Array[][];
  public readonly root: Uint8Array;
  public readonly depth: number;
  public readonly leafCount: number;

  constructor(
    input: Uint8Array[],
    hashFunc: HashFunction,
    options: MerkleTreeOptions = {}
  ) {
    if (input.length === 0) {
      throw new Error("Invalid number of leaves");
    }

    this.hashFunc = hashFunc;
    this.buildLeafMapOnInit = options.buildLeafMap ?? true;
    this.domainSeparation = options.domainSeparation ?? false;
    this.reuseHashInputBuffer = options.reuseHashInputBuffer ?? false;
    this.useXXH128 = options.useXXH128 ?? true;
    this.leafCount = input.length;
    this.leafMap = new Map();
    this.leafMapReady = false;

    const startedAt = performance.now();
    this.leaves = this.computeLeafNodes(input);
    const leavesFinishedAt = performance.now();
    console.debug(
      `[MerkleTree] Prepared ${this.leafCount} leaf nodes in ${formatDuration(leavesFinishedAt - startedAt)}`,
    );
    
    const result = this.grow();
    const growFinishedAt = performance.now();
    console.debug(
      `[MerkleTree] Grew tree in ${formatDuration(growFinishedAt - leavesFinishedAt)}`,
    );
    this.nodes = result.nodes;
    this.root = result.root;
    this.depth = result.depth;
  }

  private computeLeafNodes(input: Uint8Array[]): Uint8Array[] {
    const leaves: Uint8Array[] = new Array(input.length);
    
    for (let i = 0; i < input.length; i++) {
      const leaf = this.sproutLeaf(input[i]);
      leaves[i] = leaf;

      if (this.buildLeafMapOnInit) {
        this.leafMap.set(bytesToHex(leaf), i);
      }
    }

    this.leafMapReady = this.buildLeafMapOnInit;
    
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
    let level = this.leaves;
    let reusableHashInput: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

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
          const raw = this.combineNodePair(left, right, reusableHashInput);

          if (this.reuseHashInputBuffer && reusableHashInput.length !== raw.length) {
            reusableHashInput = raw;
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

  private combineNodePair(left: Uint8Array, right: Uint8Array, reusableHashInput: Uint8Array): Uint8Array {
    const prefixBytes = this.domainSeparation ? 1 : 0;
    const requiredLength = prefixBytes + left.length + right.length;
    const raw = this.reuseHashInputBuffer && reusableHashInput.length === requiredLength
      ? reusableHashInput
      : new Uint8Array(requiredLength);

    if (this.domainSeparation) {
      raw[0] = 0x01; // nodePrefix
      raw.set(left, 1);
      raw.set(right, 1 + left.length);
    } else {
      raw.set(left);
      raw.set(right, left.length);
    }

    return raw;
  }

  private normalizeHash(hash: Uint8Array | bigint): Uint8Array {
    if (hash instanceof Uint8Array) {
      return hash;
    }
    
    return bigintToBytes(hash, this.useXXH128 ? 16 : 8);
  }

  public generateProof(leafData: Uint8Array): MerkleProof {
    this.ensureLeafMap();

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

  private ensureLeafMap(): void {
    if (this.leafMapReady) {
      return;
    }

    for (let i = 0; i < this.leaves.length; i++) {
      this.leafMap.set(bytesToHex(this.leaves[i]), i);
    }
    this.leafMapReady = true;
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
      result = bigintToBytes(hash, useXXH128 ? 16 : 8);
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

const UINT64_MASK = (1n << 64n) - 1n;

function bigintToBytes(value: bigint, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);

  if (byteLength === 16) {
    view.setBigUint64(0, value >> 64n, false);
    view.setBigUint64(8, value & UINT64_MASK, false);
    return bytes;
  }

  if (byteLength === 8) {
    view.setBigUint64(0, value & UINT64_MASK, false);
    return bytes;
  }

  let v = value;
  for (let i = byteLength - 1; i >= 0; i--) {
    bytes[i] = Number(v & 0xFFn);
    v >>= 8n;
  }
  return bytes;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds.toFixed(1)}ms`
    : `${(milliseconds / 1000).toFixed(2)}s`;
}
