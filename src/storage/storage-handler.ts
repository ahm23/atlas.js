import { defaultEncryptionChunkSize } from '@/utils/defaults';
import { 
  EncryptionOptions,
  FileUploadOptions, 
  QueuedFile, 
  UploadOptions, 
  UploadResult,
} from './types';
import { IStorageHandler } from '@/interfaces/classes/IStorageHandler';
import { bytesToHex, extractFileMetaData } from '@/utils/converters';
import { hashAndHex } from '@/utils/hash';
import { IAesBundle } from '@/interfaces/encryption';
import { aesBlobCrypt, generateAesKey } from '@/utils/crypto';
import { nebulix, cosmos } from '@atlas/atlas.js-protos';
import { AtlasClient } from '@/atlas-client';
import { EncodeObject } from '@cosmjs/proto-signing';
import { toHex } from "@cosmjs/encoding";
import { StargateClient } from '@cosmjs/stargate';
import { QueryFileNodeResponse } from '@atlas/atlas.js-protos/dist/types/nebulix/filetree/v1/query';

import { IDirectory, IFileMeta } from '@/interfaces';
import MerkleTree from 'merkletreejs';
import { buildFileMerkleTree } from '@/utils/merkletree';
import { Provider } from '@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/provider';
import EventEmitter from 'events';

export enum FileProcessingEvent {
  ENCRYPTED = 'file:encrypted',
  MERKLE_BUILT = 'file:merkle-built',
  READY = 'file:ready',
  ERROR = 'file:error'
}

export class StorageHandler extends EventEmitter implements IStorageHandler {
  private client: AtlasClient;
  private queuedFiles: Map<string, QueuedFile> = new Map();
  private address;

  private _directory = {} as IDirectory;
  private _providers: Provider[] = [];

  constructor(client: AtlasClient) {
    super();
    this.client = client;
    this.address = client.getCurrentAddress();
  }

  static async new(client: AtlasClient, initialPath: string = 'home'): Promise<StorageHandler> {
    const handler = new StorageHandler(client);
    await handler.loadDirectory(initialPath);
    await handler.loadProviders();
    return handler;
  }

  // Getters
  get directory(): IDirectory {
    return this._directory;
  }

  get providers(): Provider[] {
    return this._providers;
  }

  /**
   * Load directory metadata and children for a given path.
   * Directory info is accessible via the directory getter.
   */
  public async loadDirectory(path: string, owner?: string) {
    // [PHASE 1]: directory loading assuming not encrypted folder and files
    // [PHASE 2]: encrypted folder and children compatibility
    // [PHASE 3]: paginated children request handling

    const dir = (await this.client.query.nebulix.filetree.v1.fileNode({ path, owner: owner || this.address })).node
    if (!dir) {
      // [TODO]: error handling
      throw new Error(`failed to get node ${path}, ${owner}`)
    }
    const children = (await this.client.query.nebulix.filetree.v1.fileNodeChildren({ path, owner: owner || this.address })).nodes ?? []
    
    let newDir: IDirectory = { metadata: JSON.parse(dir.contents), path, files: [], subdirs: [], objects: [] };
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
   * Load active provider set.
   */
  public async loadProviders() {
    try {
      this._providers = (await this.client.query.nebulix.storage.v1.providers()).providers
    } catch (err) {
      // [TODO]: proper error handling
      // this is useless.. for now
      throw err;
    }
  }

  /**
   * Queue a file immediately and process in background
   */
  queueFileAsync(
    file: File,
    options: FileUploadOptions = {}
  ): void {
    const queuedFile: QueuedFile = {
      file,
      merkleRoot: new Uint8Array(),
      replicas: options.replicas || 3,
      timestamp: Date.now(),
      rawFile: file,
      options,
      status: 'queued',
      error: ''
    };
    this.queuedFiles.set(file.name, queuedFile);
    console.debug(`Queued File ${file.name}\n`, queuedFile)

    // Start processing in background
    this.processFile(file.name, options).catch(error => {
      console.error(`Background processing failed for ${file.name}:`, error);
    });
  }

  private async processFile(
    fileName: string,
    options: FileUploadOptions
  ): Promise<void> {
    const queuedFile = this.queuedFiles.get(fileName);
    if (!queuedFile) return

    try {
      let file = queuedFile.rawFile;
      let aesBundle: IAesBundle | undefined;

      // Encryption step
      if (options.encryption) {
        this.updateFileStatus(fileName, 'encrypting');
        options.encryption.aes = options.encryption.aes || await generateAesKey();
        file = await encryptFile(file, options.encryption);

        // Update file object
        const updated = this.queuedFiles.get(fileName);
        if (updated) {
          updated.file = file;
          updated.aes = aesBundle;
          this.queuedFiles.set(fileName, updated);
        }

        this.emit(FileProcessingEvent.ENCRYPTED, {
          fileName,
          fileSize: queuedFile.rawFile.size,
          stage: FileProcessingEvent.ENCRYPTED,
          timestamp: Date.now()
        });
      }

      this.updateFileStatus(fileName, 'merkling');

      // Merkle tree step
      const tree = await buildFileMerkleTree(file);
      console.timeEnd("MerkleFile")
      console.log("merkletree built")
      const merkleRoot = tree.getRoot();

      // Update file object with merkle root
      const updated = this.queuedFiles.get(fileName);
      if (updated) {
        updated.merkleRoot = merkleRoot;
        this.queuedFiles.set(fileName, updated);
      }

      this.emit(FileProcessingEvent.MERKLE_BUILT, {
        fileName,
        fileSize: queuedFile.rawFile.size,
        stage: FileProcessingEvent.MERKLE_BUILT,
        timestamp: Date.now(),
        data: {
          merkleRoot: bytesToHex(merkleRoot)
        }
      });

      console.log(bytesToHex(merkleRoot))

      // Update status to ready
      this.updateFileStatus(fileName, 'ready');

      this.emit(FileProcessingEvent.READY, {
        fileName,
        fileSize: queuedFile.rawFile.size,
        stage: FileProcessingEvent.READY,
        timestamp: Date.now()
      });

    } catch (error: any) {
      // Update status to error
      this.updateFileStatus(fileName, 'error', error.message);
      
      this.emit(FileProcessingEvent.ERROR, {
        fileName,
        fileSize: queuedFile.rawFile.size,
        stage: FileProcessingEvent.ERROR,
        timestamp: Date.now(),
        data: {
          error: error.message
        }
      });
    }
  }

  /**
   * Update file status and emit change event
   */
  private updateFileStatus(fileName: string, status: QueuedFile['status'], error?: string): void {
    const queuedFile = this.queuedFiles.get(fileName);
    if (!queuedFile) return;

    queuedFile.status = status;
    if (error) {
      queuedFile.error = error;
      console.error(`Error processing ${fileName}! ${error}`)
    }
    
    this.queuedFiles.set(fileName, queuedFile);
    console.debug(`File ${fileName} Status: ${status}`)
    // emit status change for UI updates
    // this.emit('file:status-changed', {
    //   fileName: queuedFile.rawFile.name,
    //   status,
    //   error,
    //   timestamp: Date.now()
    // });
  }

  public async upload(dir?: string) {
    const creator = this.client.getCurrentAddress()
    if (!creator) throw new Error(`Wallet not connected`);
    // [TODO]: better way of determining this ^

    if (!this.queuedFiles.size) throw new Error("Cannot upload! Queue is empty.")
    
    const msgs: any = []
    this.queuedFiles.forEach((qfile) => {
      msgs.push(
        nebulix.filetree.v1.MessageComposer.withTypeUrl.postNode({
          creator: creator,
          path: `${dir ?? this._directory.path}/${qfile.file.name}`,
          nodeType: "file",
          contents: JSON.stringify(qfile)
        })
      )
    })

    
    try {
      const msg1 = nebulix.filetree.v1.MessageComposer.withTypeUrl.postNode({
        creator: creator,
        path: "home",
        nodeType: "directory",
        contents: ""
      })

      const msg = nebulix.filetree.v1.MessageComposer.withTypeUrl.postNode({
        creator: creator,
        path: "home/test.txt",
        nodeType: "file",
        contents: ""
      })
      const txHash = await this.client.signAndBroadcast([msg1, msg])

      // [TODO]: actual file upload

      // remove from staged files after successful upload
      // this.queuedFiles.delete(qfile);

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
   * Upload a staged file to the blockchain
   * Broadcasts a transaction to register the file
   */
  private async old_uploadQueuedFile(
    queuedId: string,
    options: UploadOptions = {}
  ): Promise<UploadResult> {

    const creator = this.client.getCurrentAddress()
    if (!creator) throw new Error(`Wallet not connected`);
    // [TODO]: better way of determining this ^

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
        creator: creator,
        path: "home",
        nodeType: "directory",
        contents: ""
      })

      const msg = nebulix.filetree.v1.MessageComposer.withTypeUrl.postNode({
        creator: creator,
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

async function encryptFile(file: File, opts: EncryptionOptions): Promise<File> {
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
