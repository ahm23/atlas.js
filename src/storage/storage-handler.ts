import { defaultEncryptionChunkSize } from '@/utils/defaults';
import { 
  FileOptions, 
  QueuedFile, 
  UploadOptions, 
  UploadResult,
} from './types';
import { extractFileMetaData } from '@/utils/converters';
import { hashAndHex } from '@/utils/hash';
import { IAesBundle } from '@/interfaces/encryption';
import { aesBlobCrypt, generateAesKey } from '@/utils/crypto';
import { nebulix } from '@atlas/atlas.js-protos';
import { AtlasClient } from '@/atlas-client';

export class StorageHandler {
  private client: AtlasClient;
  private queuedFiles: Map<string, QueuedFile> = new Map();

  constructor(client: AtlasClient) {
    this.client = client;
  }

  /**
   * Stage a file for upload
   * Prepares the file by hashing, optional encryption, and chunking
   */
  async queueFile(
    file: File,
    options: FileOptions = {}
  ): Promise<QueuedFile> {
    try {
      const fileMeta = extractFileMetaData(file)
      const queuedId = await hashAndHex(fileMeta.name + Date.now().toString())
      let aes: IAesBundle;

      if (options.encrypt) {
        aes = await generateAesKey();
        const encryptedArray: Blob[] = []
        for (let i = 0; i < file.size; i += options.chunkSize ?? defaultEncryptionChunkSize) {
          const blobChunk = file.slice(i, i + (options.chunkSize ?? defaultEncryptionChunkSize))
          encryptedArray.push(
            new Blob([(blobChunk.size + 16).toString().padStart(8, '0')]),
            await aesBlobCrypt(blobChunk, aes, 'encrypt'),
          )
        }

        file = new File(encryptedArray, queuedId, { type: 'text/plain' })
      }

      // [TODO]: MERKLE IT!

      // create staged file object
      const stagedFile: QueuedFile = {
        id: queuedId,
        file,
        fileMeta,
        merkleRoot: new Uint8Array(),
        aes,
        timestamp: Date.now(),
      };

      // Store in memory
      this.queuedFiles.set(queuedId, stagedFile);

      return stagedFile;
    } catch (error) {
      throw new Error(`Failed to stage file: ${error.message}`);
    }
  }

  /**
   * Upload a staged file to the blockchain
   * Broadcasts a transaction to register the file
   */
  async uploadQueuedFile(
    queuedId: string,
    options: UploadOptions = {}
  ): Promise<UploadResult> {
    try {
      // Get the staged file
      const queuedFile = this.queuedFiles.get(queuedId);
      if (!queuedFile) {
        throw new Error(`No queued file found with ID: ${queuedId}`);
      }

      const msg = nebulix.storage.v1.MessageComposer.encoded.postFile({
          creator: this.client.getCurrentAddress(),
          merkle: queuedFile.merkleRoot,
          fileSize: BigInt(queuedFile.file.size),
          replicas: BigInt(queuedFile.replicas ?? 3),
          subscription: ""
        })

      const txHash = await this.client.signAndBroadcast([msg])

      // [TODO]: actual file upload

      // remove from staged files after successful upload
      this.queuedFiles.delete(queuedId);

      return {
        fileId: "",
        transactionHash: txHash,
        storageNodes: [],
        timestamp: Date.now()
      };
    } catch (error) {
      throw new Error(`Failed to upload file: ${error.message}`);
    }
  }

  /**
   * List all queued files
   */
  listQueuedFiles(): QueuedFile[] {
    return Array.from(this.queuedFiles.values());
  }

  /**
   * Remove queued file
   */
  removeQueuedFile(id: string): boolean {
    return this.queuedFiles.delete(id);
  }

  /**
   * Clear all queued files
   */
  clearQueuedFiles(): void {
    this.queuedFiles.clear();
  }
}