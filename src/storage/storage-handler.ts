import { DEFAULT_ENCYRPTION_CHUNK_SIZE, DEFAULT_REPLICAS } from '@/utils/defaults';
import { 
  IEncryptionOptions,
  IFileUploadOptions, 
  QueuedFile, 
  IFileMetadata, 
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
import { CancellationException, FileNotInQueue } from './exceptions';

export enum FileProcessingEvent {
  ENCRYPTED = 'file:encrypted',
  MERKLE_BUILT = 'file:merkle-built',
  READY = 'file:ready',
  ERROR = 'file:error'
}

export type StorageEvents = FileProcessingEvent // | UploadEvent;

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

  declare on: (event: StorageEvents | string, listener: (...args: any[]) => void) => this;
  declare emit: (event: StorageEvents | string, ...args: any[]) => boolean;

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
    options: IFileUploadOptions = {}
  ): void {
    // add the file to the upload queue
    const queuedFile: QueuedFile = {
      file,
      merkleRoot: new Uint8Array(),
      replicas: options.replicas || DEFAULT_REPLICAS,
      encryption: options.encrypt ? options.encryptOpts ?? {} : undefined,
      metadata: { name: file.name.replace(/\.[^/.]+$/, "") },
      status: 'idle'
    };
    this.queuedFiles.set(file.name, queuedFile);
    console.debug(`Queued File ${file.name}\n`, queuedFile)

    // start background file processing
    this.processFile(file.name).catch(error => {
      // console.error(`Background processing failed for ${file.name}:`, error);
    });
  }

  private processFile(
    fileKey: string,
  ): Promise<void> {
    return new Promise(async (_, reject) => {
      const qfile = this.queuedFiles.get(fileKey);
      if (!qfile) return

      try {
        const abortController = new AbortController();
        qfile.abortController = abortController;
        this.queuedFiles.set(fileKey, qfile);

        const signal = abortController.signal;
        console.log('Created AbortController, signal.aborted:', signal.aborted);

        /// Phase 1: encryption
        if (qfile.encryption) {
          this.updateQueuedFileStatus(fileKey, 'encrypting');
          qfile.encryption.aes = qfile.encryption.aes || await generateAesKey();

           if (!qfile.abortController) {
          throw new Error('AbortController disappeared!');
        }
          qfile.file = await encryptFile(qfile.file, qfile.encryption, qfile.abortController.signal);

          this.emit(FileProcessingEvent.ENCRYPTED, fileKey, {
            fileSize: qfile.file.size
          });
        }

        this.updateQueuedFileStatus(fileKey, 'merkling');

        /// Phase 2: merkle root
        const tree = await buildFileMerkleTree(qfile.file, qfile.abortController.signal);
        qfile.merkleRoot = tree.getRoot();

        this.emit(FileProcessingEvent.MERKLE_BUILT, fileKey, {
          merkleRoot: bytesToHex(qfile.merkleRoot)
        });

        this.queuedFiles.set(fileKey, qfile);

        // update status to ready
        this.updateQueuedFileStatus(fileKey, 'ready');
        if (qfile.abortController.signal.aborted) 
          throw new CancellationException()
        else
          this.emit(FileProcessingEvent.READY, fileKey);

      } catch (error: unknown) {
        this.updateQueuedFileStatus(fileKey, 'error');
        if (error instanceof CancellationException) {
          console.error(`File processing cancelled for ${fileKey} -- ${error.message}`);
          this.removeQueuedFile(fileKey)
        } else if (error instanceof Error) {
          console.error(`Error during file processing for ${fileKey}: ${error.message}`);
          this.emit(FileProcessingEvent.ERROR, fileKey, error.message);
        } else {
          console.error('An unknown error occurred');
          this.emit(FileProcessingEvent.ERROR, fileKey, "unknown error");
        }
        reject()
      }   
    })
  }

  /**
   * Update file status and emit change event
   */
  private updateQueuedFileStatus(fileKey: string, status: QueuedFile['status']): void {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) throw new FileNotInQueue(`File ${fileKey} not found in upload queue!`);

    queuedFile.status = status;
    this.queuedFiles.set(fileKey, queuedFile);
    return;
  }

  public updateQueuedFileMetadata(fileKey: string, metadata: Partial<IFileMetadata>) {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) throw new FileNotInQueue(`File ${fileKey} not found in upload queue!`);

    for (const [key, value] of Object.entries(metadata)) {
      queuedFile[key] = value
    }
    return;
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
    // options: IFileMetadata = {}
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
  removeQueuedFile(fileKey: string): void {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (queuedFile && queuedFile.status != 'ready') queuedFile.abortController.abort();
    else this.queuedFiles.delete(fileKey);
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

async function encryptFile(file: File, opts: IEncryptionOptions, signal: AbortSignal): Promise<File> {
  if (!opts.aes) throw new Error("AES key & iv are required in the encryption options!")

  const encryptedBytes: Blob[] = []
  for (let i = 0; i < file.size; i += opts.chunkSize ?? DEFAULT_ENCYRPTION_CHUNK_SIZE) {
    if (signal.aborted) {
      throw new CancellationException('Encryption cancelled');
    }
    const blobChunk = file.slice(i, i + (opts.chunkSize ?? DEFAULT_ENCYRPTION_CHUNK_SIZE))
    encryptedBytes.push(
      new Blob([(blobChunk.size + 16).toString().padStart(8, '0')]),
      await aesBlobCrypt(blobChunk, opts.aes, 'encrypt'),
    )
  }

  return new File(encryptedBytes, file.name, { type: file.type, lastModified: file.lastModified })
}
