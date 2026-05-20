import { createBLAKE3, type IHasher } from "hash-wasm";

interface Blake3LeafHashRequest {
  id: number;
  buffer: ArrayBuffer;
  chunkSize: number;
}

interface Blake3LeafHashResponse {
  id: number;
  hashes?: ArrayBuffer;
  leafCount?: number;
  error?: string;
}

let hasherPromise: Promise<IHasher> | undefined;
const workerScope = self as unknown as {
  postMessage: (message: Blake3LeafHashResponse, transfer?: Transferable[]) => void;
};

function postWorkerError(id: number, error: unknown): void {
  workerScope.postMessage({
    id,
    error: formatWorkerError(error),
  });
}

function formatWorkerError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown BLAKE3 worker error";
  }
}

self.addEventListener("error", (event) => {
  postWorkerError(-1, event.error || event.message || "Unhandled BLAKE3 worker error");
});

self.addEventListener("unhandledrejection", (event) => {
  postWorkerError(-1, event.reason || "Unhandled BLAKE3 worker promise rejection");
});

function getHasher(): Promise<IHasher> {
  hasherPromise ??= createBLAKE3();
  return hasherPromise;
}

self.onmessage = async (event: MessageEvent<Blake3LeafHashRequest>) => {
  const { id, buffer, chunkSize } = event.data;

  try {
    const bytes = new Uint8Array(buffer);
    const leafCount = Math.ceil(bytes.length / chunkSize);
    const hashes = new Uint8Array(leafCount * 32);
    const hasher = await getHasher();

    for (let offset = 0, leafIndex = 0; offset < bytes.length; offset += chunkSize, leafIndex++) {
      hasher.init();
      hasher.update(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
      hashes.set(hasher.digest("binary"), leafIndex * 32);
    }

    const response: Blake3LeafHashResponse = {
      id,
      hashes: hashes.buffer,
      leafCount,
    };
    workerScope.postMessage(response, [hashes.buffer]);
  } catch (error) {
    postWorkerError(id, error);
  }
};
