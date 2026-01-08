import { defaultEncryptionChunkSize } from '@/utils/defaults';
import { 
  EncryptionOptions,
  FileUploadOptions, 
  QueuedFile, 
  UploadOptions, 
  UploadResult,
} from './types';
import { IStorageHandler } from '@/interfaces/classes/IStorageHandler';
import { extractFileMetaData } from '@/utils/converters';
import { hashAndHex } from '@/utils/hash';
import { IAesBundle } from '@/interfaces/encryption';
import { aesBlobCrypt, generateAesKey } from '@/utils/crypto';
import { nebulix, cosmos } from '@atlas/atlas.js-protos';
import { AtlasClient } from '@/atlas-client';
import { EncodeObject } from '@cosmjs/proto-signing';
import { toHex } from "@cosmjs/encoding";
import { StargateClient } from '@cosmjs/stargate';
import { QueryFileTreeNodeResponse } from '@atlas/atlas.js-protos/dist/types/nebulix/filetree/v1/query';

import { IDirectory, IFileMeta } from '@/interfaces';

export class StorageHandler implements IStorageHandler {
  private client: AtlasClient;
  private queuedFiles: Map<string, QueuedFile> = new Map();
  private address;

  private _directory = {} as IDirectory;
  get directory(): IDirectory {
    return this._directory;
  }

  constructor(client: AtlasClient) {
    this.client = client;
    this.address = client.getCurrentAddress();
  }

  /**
   * Load directory metadata and children for a given path.
   * Directory info is accessible via the directory getter.
   */
  public async loadDirectory(path: string, owner?: string) {
    // [PHASE 1]: directory loading assuming not encrypted folder and files
    // [PHASE 2]: encrypted folder and children compatibility
    // [PHASE 3]: paginated children request handling

    const dir = (await this.client.query.nebulix.filetree.v1.fileTreeNode({ path, owner: owner || this.address })).node
    const children = (await this.client.query.nebulix.filetree.v1.fileTreeNodeChildren({ path, owner: owner || this.address })).children
    
    let newDir: IDirectory = { metadata: JSON.parse(dir.contents), files: [], subdirs: [], objects: [] };
    for (const node of children) {
      switch (node.nodeType) {
        case "directory":
          newDir.subdirs.push(JSON.parse(node.contents))
          break;
        case "file":
          newDir.files.push(JSON.parse(node.contents))
          break;
        default:
          newDir.objects.push(node.contents)
      }
    }

    this._directory = newDir
  }

  /**
   * Stage a file for upload
   * Prepares the file by hashing, optional encryption, and chunking
   */
  public async queueFile(
    file: File,
    options: FileUploadOptions
  ): Promise<QueuedFile> {
    try {
      if (options.encryption) {
        options.encryption.aes = options.encryption.aes ?? await generateAesKey();

        file = await this.encryptFile(file, options.encryption)
      }

      // [TODO]: MERKLE IT!

      // create staged file object
      const stagedFile: QueuedFile = {
        file,
        merkleRoot: new Uint8Array(),
        aes: options.encryption?.aes,
        timestamp: Date.now(),
      };

      // Store in memory
      this.queuedFiles.set(file.name, stagedFile);

      return stagedFile;
    } catch (err) {
      // [TODO]: proper error handling
      // this is useless.. for now
      throw err;
    }
  }


  private async encryptFile(file: File, opts: EncryptionOptions): Promise<File> {
    if (!opts.aes) throw new Error("AES key & iv are required in the encryption options!")

    const encryptedBytes: Blob[] = []
    for (let i = 0; i < file.size; i += opts.chunkSize ?? defaultEncryptionChunkSize) {
      const blobChunk = file.slice(i, i + (opts.chunkSize ?? defaultEncryptionChunkSize))
      encryptedBytes.push(
        new Blob([(blobChunk.size + 16).toString().padStart(8, '0')]),
        await aesBlobCrypt(blobChunk, opts.aes, 'encrypt'),
      )
    }

    return new File(encryptedBytes, file.name, { type: file.type, lastModified: file.lastModified })
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

      // const msg = nebulix.storage.v1.MessageComposer.encoded.postFile({
      //     creator: this.client.getCurrentAddress(),
      //     merkle: queuedFile.merkleRoot,
      //     fileSize: BigInt(queuedFile.file.size),
      //     replicas: BigInt(queuedFile.replicas ?? 3),
      //     subscription: ""
      //   })

      // const protoMsg = nebulix.storage.v1.MsgBuyStorage.toProtoMsg({
      //   creator: this.client.getCurrentAddress(),
      //   receiver: '',
      //   duration: BigInt(720),
      //   bytes: BigInt(1000000000),
      //   isDefault: true
      // })
      // await debugEncoding()
      // const msg = nebulix.storage.v1.MessageComposer.withTypeUrl.buyStorage({
      //   creator: this.client.getCurrentAddress(),
      //   receiver: this.client.getCurrentAddress(),
      //   duration: 720n,
      //   bytes: 100000000n,
      //   isDefault: true
      // })

      // const cmsg_raw = cosmos.bank.v1beta1.MsgSend.fromPartial({
      //   fromAddress: this.client.getCurrentAddress(),
      //   toAddress: this.client.getCurrentAddress(),
      //   amount: [{ denom: "uatl", amount: "1000" }]
      // })

      // const cmsg = {
      //   typeUrl: cosmos.bank.v1beta1.MsgSend.typeUrl,
      //   value: cmsg_raw
      // }

      const msg1 = nebulix.filetree.v1.MessageComposer.withTypeUrl.postNode({
        creator: this.client.getCurrentAddress(),
        path: "home",
        nodeType: "directory",
        contents: ""
      })

      const msg = nebulix.filetree.v1.MessageComposer.withTypeUrl.postNode({
        creator: this.client.getCurrentAddress(),
        path: "home/test.txt",
        nodeType: "file",
        contents: ""
      })
      const txHash = await this.client.signAndBroadcast([msg1, msg])

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
      throw new Error(`Failed to upload file: ${error}`);
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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
