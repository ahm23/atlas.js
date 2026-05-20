// merkletree.ts

export type HashFunction = (data: Uint8Array) => Uint8Array | bigint;

const TREE_GROW_YIELD_INTERVAL = 50000;
const TREE_GROW_PROGRESS_THROTTLE = 0.5;
const LEAF_NODE_YIELD_INTERVAL = 50000;

interface MerkleTreeOptions {
  buildLeafMap?: boolean;
  domainSeparation?: boolean;
  reuseHashInputBuffer?: boolean;
  useXXH128?: boolean;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
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

  /**
   * Async factory that builds the tree with periodic event-loop yielding and
   * throttled progress callbacks, keeping the UI responsive for large trees.
   */
  static async buildAsync(
    input: Uint8Array[],
    hashFunc: HashFunction,
    options: MerkleTreeOptions = {},
  ): Promise<MerkleTree> {
    if (input.length === 0) {
      throw new Error("Invalid number of leaves");
    }

    const tree = Object.create(MerkleTree.prototype);
    tree.hashFunc = hashFunc;
    tree.buildLeafMapOnInit = options.buildLeafMap ?? true;
    tree.domainSeparation = options.domainSeparation ?? false;
    tree.reuseHashInputBuffer = options.reuseHashInputBuffer ?? false;
    tree.useXXH128 = options.useXXH128 ?? true;
    tree.leafCount = input.length;
    tree.leafMap = new Map();
    tree.leafMapReady = false;

    const startedAt = performance.now();
    const result = await tree.growAsync(input, options.onProgress, options.signal);
    const growFinishedAt = performance.now();
    console.debug(
      `[MerkleTree] Grew tree in ${formatDuration(growFinishedAt - startedAt)} (${tree.leafCount} leaves)`,
    );
    tree.nodes = result.nodes;
    tree.root = result.root;
    tree.depth = result.depth;
    return tree;
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

  private async growAsync(
    input: Uint8Array[],
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<{ nodes: Uint8Array[][]; root: Uint8Array; depth: number }> {
    const totalUnits = input.length * 2 - 1; // sproutLeaf per leaf + pair hash per interior node
    let completedUnits = 0;
    let nextReportAt = 0;

    const report = (pct: number) => {
      if (!onProgress) return;
      if (pct >= nextReportAt) {
        onProgress(pct);
        nextReportAt = pct - (pct % TREE_GROW_PROGRESS_THROTTLE) + TREE_GROW_PROGRESS_THROTTLE;
      }
    };

    // Phase 1: sproutLeaf for each input leaf
    this.leaves = new Array(input.length);
    for (let i = 0; i < input.length; i++) {
      this.leaves[i] = this.sproutLeaf(input[i]);
      if (this.buildLeafMapOnInit) {
        this.leafMap.set(bytesToHex(this.leaves[i]), i);
      }
      completedUnits++;
      report((completedUnits / totalUnits) * 100);

      if (i > 0 && i % LEAF_NODE_YIELD_INTERVAL === 0) {
        if (signal?.aborted) throw new Error('Cancelled');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    this.leafMapReady = this.buildLeafMapOnInit;

    if (signal?.aborted) throw new Error('Cancelled');

    // Phase 2: grow tree levels
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
          completedUnits++;
          report((completedUnits / totalUnits) * 100);

          if (completedUnits % TREE_GROW_YIELD_INTERVAL === 0) {
            if (signal?.aborted) throw new Error('Cancelled');
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      if (signal?.aborted) throw new Error('Cancelled');

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
        path &= ~(1 << siblingBit);
      } else {
        siblingIdx = currentIdx + 1;
        path |= (1 << siblingBit);
      }

      siblingBit++;

      if (siblingIdx < levelNodes.length) {
        siblings.push(levelNodes[siblingIdx]);
      } else {
        // If sibling doesn't exist, hash with itself
        siblings.push(levelNodes[currentIdx]);
      }

      currentIdx >>= 1;
    }

    return {
      siblings,
      index,
      path,
    };
  }

  public verifyProof(leafData: Uint8Array, proof: MerkleProof, root: Uint8Array): boolean {
    let current = this.sproutLeaf(leafData);
    let currentIdx = proof.index;

    for (let i = 0; i < proof.siblings.length; i++) {
      const sibling = proof.siblings[i];
      const isRightChild = (currentIdx & 1) === 1;

      let raw: Uint8Array;
      if (isRightChild) {
        raw = this.combineNodePair(sibling, current);
      } else {
        raw = this.combineNodePair(current, sibling);
      }

      current = this.normalizeHash(this.hashFunc(raw));
      currentIdx >>= 1;
    }

    return bytesToHex(current) === bytesToHex(root);
  }

  private ensureLeafMap(): void {
    if (!this.leafMapReady) {
      for (let i = 0; i < this.leaves.length; i++) {
        this.leafMap.set(bytesToHex(this.leaves[i]), i);
      }
      this.leafMapReady = true;
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bigintToBytes(value: bigint, byteLength: number): Uint8Array {
  const hex = value.toString(16).padStart(byteLength * 2, '0').slice(0, byteLength * 2);
  const bytes = new Uint8Array(byteLength);

  for (let i = 0; i < byteLength; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds.toFixed(1)}ms`
    : `${(milliseconds / 1000).toFixed(2)}s`;
}
