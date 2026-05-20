import { MerkleTree } from "./atlas-merkletree";
import Blake3Worker from "./blake3-worker?worker&inline";
import { h_blake3, h_xxh3 } from "./hash";

const DEFAULT_CHUNK_SIZE = 1024;
const LEAF_HASH_YIELD_INTERVAL = 8192;
const LEAF_HASH_BYTE_LENGTH = 32;
const BLAKE3_WORKER_BATCH_BYTES = 16 * 1024 * 1024;
const BLAKE3_WORKER_MIN_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BLAKE3_WORKERS = 8;
const BLAKE3_WORKER_DESCRIPTION = "src/utils/blake3-worker.ts?worker&inline";

interface LeafHashResult {
  leafHashes: Uint8Array[];
  yieldCount: number;
  workerCount: number;
}

export interface MerkleTreeBuildProgress {
  progress: number;
}

interface MerkleTreeBuildOptions {
  onProgress?: (progress: MerkleTreeBuildProgress) => void;
}

interface Blake3WorkerResponse {
  id: number;
  hashes?: ArrayBuffer;
  leafCount?: number;
  error?: string;
}

interface Blake3WorkerJob {
  leafStart: number;
}

const LEAF_HASHING_WEIGHT = 40;

export async function buildFileMerkleTree(
  bytes: Blob,
  signal: AbortSignal,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options: MerkleTreeBuildOptions = {},
): Promise<MerkleTree> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }

  const startedAt = performance.now();

  console.debug(
    `[MerkleTree] Hashing ${bytes.size} bytes into ${chunkSize}-byte leaves`,
  );

  // Scale leaf hashing progress (0–100% internally) to 0–LEAF_HASHING_WEIGHT%
  // so tree-building gets the remaining (LEAF_HASHING_WEIGHT–100)%.
  const leafOptions: MerkleTreeBuildOptions = options.onProgress
    ? { onProgress: (p) => options.onProgress!({ progress: (p.progress / 100) * LEAF_HASHING_WEIGHT }) }
    : {};

  const { leafHashes, yieldCount, workerCount } = await hashFileLeaves(bytes, signal, chunkSize, leafOptions);
  const leafHashFinishedAt = performance.now();
  console.debug(
    `[MerkleTree] Hashed ${leafHashes.length} leaves in ${formatDuration(leafHashFinishedAt - startedAt)} (${workerCount > 0 ? `${workerCount} workers` : `${yieldCount} yields`})`,
  );

  if (signal.aborted) {
    throw new Error('Cancelled');
  }

  const treeStartedAt = performance.now();
  const tree = await MerkleTree.buildAsync(leafHashes, h_xxh3, {
    buildLeafMap: false,
    domainSeparation: false,
    reuseHashInputBuffer: true,
    useXXH128: true,
    signal,
    onProgress: (treeProgress) => {
      options.onProgress?.({
        progress: LEAF_HASHING_WEIGHT + (treeProgress / 100) * (100 - LEAF_HASHING_WEIGHT),
      });
    },
  });
  console.debug(
    `[MerkleTree] Built ${tree.nodes.length} levels/${tree.leafCount} leaves in ${formatDuration(performance.now() - treeStartedAt)}`,
  );
  console.debug(
    `[MerkleTree] Total merkle time ${formatDuration(performance.now() - startedAt)}`,
  );

  return tree;
}

async function hashFileLeaves(
  bytes: Blob,
  signal: AbortSignal,
  chunkSize: number,
  options: MerkleTreeBuildOptions,
): Promise<LeafHashResult> {
  if (canUseBlake3Workers(bytes)) {
    try {
      return await hashFileLeavesWithWorkers(bytes, signal, chunkSize, options);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }

      console.debug("[MerkleTree] BLAKE3 workers failed; falling back to main-thread hashing", error);
    }
  }

  return hashFileLeavesOnMainThread(bytes, signal, chunkSize, options);
}

function canUseBlake3Workers(bytes: Blob): boolean {
  return bytes.size >= BLAKE3_WORKER_MIN_FILE_BYTES
    && typeof Worker !== "undefined";
}

async function hashFileLeavesWithWorkers(
  bytes: Blob,
  signal: AbortSignal,
  chunkSize: number,
  options: MerkleTreeBuildOptions,
): Promise<LeafHashResult> {
  const batchSize = Math.max(
    chunkSize,
    Math.floor(BLAKE3_WORKER_BATCH_BYTES / chunkSize) * chunkSize,
  );
  const jobCount = Math.ceil(bytes.size / batchSize);
  const workerCount = getBlake3WorkerCount(jobCount);
  const leafHashes: Uint8Array[] = new Array(Math.ceil(bytes.size / chunkSize));
  const workers: Worker[] = [];
  const activeJobs = new Map<number, Blake3WorkerJob>();
  let nextJobId = 0;
  let completedJobs = 0;
  let completedLeaves = 0;

  return new Promise<LeafHashResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      for (const worker of workers) {
        worker.terminate();
      }
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      reportMerkleProgress(options, bytes.size, chunkSize, leafHashes.length);
      cleanup();
      resolve({
        leafHashes,
        yieldCount: 0,
        workerCount,
      });
    };

    const abort = () => fail(new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    const assignJob = async (worker: Worker) => {
      if (settled || signal.aborted) {
        return;
      }

      const id = nextJobId++;
      if (id >= jobCount) {
        return;
      }

      const start = id * batchSize;
      const end = Math.min(start + batchSize, bytes.size);
      activeJobs.set(id, {
        leafStart: start / chunkSize,
      });

      try {
        const buffer = await bytes.slice(start, end).arrayBuffer();
        if (settled || signal.aborted) {
          return;
        }

        worker.postMessage({ id, buffer, chunkSize }, [buffer]);
      } catch (error) {
        fail(error);
      }
    };

    for (let i = 0; i < workerCount; i++) {
      let worker: Worker;

      try {
        worker = new Blake3Worker();
        workers.push(worker);
      } catch (error) {
        fail(createBlake3WorkerStartupError(error));
        break;
      }

      worker.onmessage = (event: MessageEvent<Blake3WorkerResponse>) => {
        const { id, hashes, leafCount, error } = event.data;
        const job = activeJobs.get(id);
        activeJobs.delete(id);

        if (settled) {
          return;
        }

        if (error) {
          fail(new Error(`BLAKE3 worker reported an error for job ${id}: ${error}`));
          return;
        }

        if (!job || !hashes || leafCount === undefined) {
          fail(new Error("Invalid BLAKE3 worker response"));
          return;
        }

        const jobHashes = new Uint8Array(hashes);
        for (let i = 0; i < leafCount; i++) {
          const hashStart = i * LEAF_HASH_BYTE_LENGTH;
          leafHashes[job.leafStart + i] = jobHashes.subarray(hashStart, hashStart + LEAF_HASH_BYTE_LENGTH);
        }
        completedLeaves += leafCount;
        reportMerkleProgress(options, bytes.size, chunkSize, completedLeaves);

        completedJobs++;
        if (completedJobs === jobCount) {
          finish();
          return;
        }

        void assignJob(worker);
      };

      worker.onerror = (event) => {
        fail(createBlake3WorkerRuntimeError(event));
      };

      worker.onmessageerror = (event) => {
        fail(new Error(
          `BLAKE3 worker message deserialization failed for ${BLAKE3_WORKER_DESCRIPTION}. `
          + `Event type: ${event.type}.`,
        ));
      };

      void assignJob(worker);
    }
  });
}

function createBlake3WorkerStartupError(error: unknown): Error {
  const detail = error instanceof Error
    ? error.stack || error.message
    : String(error);

  return new Error(`Failed to start BLAKE3 worker (${getBlake3WorkerUrlForLog()}): ${detail}`);
}

function createBlake3WorkerRuntimeError(event: ErrorEvent): Error {
  const details = [
    event.message && `message="${event.message}"`,
    event.filename && `filename="${event.filename}"`,
    event.lineno && `line=${event.lineno}`,
    event.colno && `column=${event.colno}`,
    event.error instanceof Error && `error="${event.error.stack || event.error.message}"`,
  ].filter(Boolean);

  const suffix = details.length > 0
    ? details.join(", ")
    : "no ErrorEvent details were provided by the browser";

  return new Error(
    `BLAKE3 worker failed while loading or running ${getBlake3WorkerUrlForLog()}: ${suffix}. `
    + "This often means the worker asset was not served, was served with the wrong MIME type, "
    + "or an exception happened before the worker could post a structured error.",
  );
}

function getBlake3WorkerUrlForLog(): string {
  return BLAKE3_WORKER_DESCRIPTION;
}

function getBlake3WorkerCount(jobCount: number): number {
  const hardwareConcurrency = typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;

  return Math.max(1, Math.min(jobCount, MAX_BLAKE3_WORKERS, Math.max(1, hardwareConcurrency - 1)));
}

async function hashFileLeavesOnMainThread(
  bytes: Blob,
  signal: AbortSignal,
  chunkSize: number,
  options: MerkleTreeBuildOptions,
): Promise<LeafHashResult> {
  const leafHashes: Uint8Array[] = [];
  const stream = bytes.stream();
  const reader = stream.getReader();
  const chunkBuffer = new Uint8Array(chunkSize);
  let chunkOffset = 0;
  let yieldCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        let valueOffset = 0;

        while (valueOffset < value.length) {
          if (signal.aborted) throw new Error("Cancelled");

          if (chunkOffset === 0 && value.length - valueOffset >= chunkSize) {
            const chunkEnd = valueOffset + chunkSize;
            leafHashes.push(h_blake3(value.subarray(valueOffset, chunkEnd)));
            valueOffset = chunkEnd;

            if ((leafHashes.length & (LEAF_HASH_YIELD_INTERVAL - 1)) === 0) {
              yieldCount++;
              reportMerkleProgress(options, bytes.size, chunkSize, leafHashes.length);
              await new Promise((resolve) => setTimeout(resolve, 0));
            }

            continue;
          }

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
            reportMerkleProgress(options, bytes.size, chunkSize, leafHashes.length);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }

      if (done) {
        if (chunkOffset > 0) {
          const finalHash = h_blake3(chunkBuffer.subarray(0, chunkOffset));
          leafHashes.push(finalHash);
        }
        reportMerkleProgress(options, bytes.size, chunkSize, leafHashes.length);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    leafHashes,
    yieldCount,
    workerCount: 0,
  };
}

function reportMerkleProgress(
  options: MerkleTreeBuildOptions,
  bytesSize: number,
  chunkSize: number,
  completedLeaves: number,
): void {
  if (!options.onProgress) {
    return;
  }

  const totalLeaves = Math.max(1, Math.ceil(bytesSize / chunkSize));
  const pct = Math.min(100, (completedLeaves / totalLeaves) * 100);

  options.onProgress({ progress: pct });
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds.toFixed(1)}ms`
    : `${(milliseconds / 1000).toFixed(2)}s`;
}
