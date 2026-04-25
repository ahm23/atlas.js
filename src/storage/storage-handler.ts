import { DEFAULT_ENCYRPTION_CHUNK_SIZE, DEFAULT_REPLICAS } from '@/utils/defaults';
import { 
  IEncryptionOptions,
  IFileUploadOptions, 
  IQueuedFile, 
  IFileMetadata, 
  UploadResult,
  ITreeNodeContents,
  IDriveNodeContents,
  IDirectoryNodeContents,
  IStagedFile,
} from './types';
import { IStorageHandler } from '@/interfaces/classes/IStorageHandler';
import { bytesToHex, extractFileMetaData } from '@/utils/converters';
import { buildFid, hashAndHex } from '@/utils/hash';
import { IAesBundle } from '@/interfaces/encryption';
import { aesBlobCrypt, generateAesKey } from '@/utils/crypto';
import { atlas, cosmos } from '@atlas/atlas.js-protos';
import { AtlasClient } from '@/atlas-client';
import { EncodeObject } from '@cosmjs/proto-signing';
import { toHex } from "@cosmjs/encoding";
import { StargateClient } from '@cosmjs/stargate';
import { QueryTreeNodeResponse } from '@atlas/atlas.js-protos/dist/types/atlas/filetree/v1/query';

import { IDirectory, IFileMeta, IAtlasDriveInfo } from '@/interfaces';
import MerkleTree from 'merkletreejs';
import { buildFileMerkleTree } from '@/utils/merkletree';
import { Provider } from '@atlas/atlas.js-protos/dist/types/atlas/storage/v1/provider';
import EventEmitter from 'events';
import { CancellationException, FileNotInQueue } from './exceptions';
import { MessageComposer } from '@/messages/composer';
import { UploadHelper } from './upload-helper';
import { StorageSubscription } from '@atlas/atlas.js-protos/dist/types/atlas/storage/v1/subscription';
import { MsgBuyStorage } from '@atlas/atlas.js-protos/dist/types/atlas/storage/v1/tx';
import { MsgPostNode } from '@atlas/atlas.js-protos/dist/types/atlas/filetree/v1/tx';

export enum FileProcessingEvent {
  ENCRYPTED = 'file:encrypted',
  MERKLE_BUILT = 'file:merkle-built',
  READY = 'file:ready',
  ERROR = 'file:error'
}

export enum StorageHandlerEvent {
  NAV_DIR = 'navigate-dir',
  NEW_SUB = 'subscription-loaded',
  NO_SUB = 'no-subscription'
}

export type StorageEvents = FileProcessingEvent | StorageHandlerEvent;

export class StorageHandler extends EventEmitter implements IStorageHandler {
  private client: AtlasClient;
  private queuedFiles: Map<string, IQueuedFile> = new Map();
  private stagedFiles: Map<string, IFileMetadata> = new Map();

  private address;
  private _activeSubscription: StorageSubscription | undefined

  private _drives: IAtlasDriveInfo[] = [];
  private _directory = {path: "", files: [], subdirs: [], objects: []} as IDirectory;
  private _providers: Provider[] = [];

  constructor(client: AtlasClient) {
    super();
    this.client = client;
    this.address = client.getCurrentAddress();

    this.selectAccount = this.selectAccount.bind(this)
    this.client.on('walletConnected', this.selectAccount)
  }

  declare on: (event: StorageEvents | string, listener: (...args: any[]) => void) => this;
  declare emit: (event: StorageEvents | string, ...args: any[]) => boolean;

  static async new(client: AtlasClient, initialPath: string = 's'): Promise<StorageHandler> {
    const handler = new StorageHandler(client)
    await handler.loadSubscription()
    await handler.loadDirectory(initialPath)
    await handler.loadProviders()
    return handler
  }

  // Getters
  public get ready(): boolean {
    return this._activeSubscription != undefined
  }

  public get directory(): IDirectory {
    return this._directory;
  }

  public get subscriptionId(): string {
    return this._activeSubscription?.id
  }

  public get subscriptionStatus(): string {
    return this._activeSubscription?.status
  }

  public get storageUsed(): number {
    return Number(this._activeSubscription?.spaceUsed)
  }

  public get storageTotal(): number {
    return Number(this._activeSubscription?.spaceAvailable)
  }

  public get providers(): Provider[] {
    return this._providers;
  }

  public async loadSubscription(id?: string): Promise<boolean> {
    try {
      this._activeSubscription = await this.client.query.subscription(this.address, id)
      this.emit(StorageHandlerEvent.NEW_SUB)
      console.debug("[StorageHandler] Active Subscription:", this._activeSubscription)
      return true;
    } catch {
      this.emit(StorageHandlerEvent.NO_SUB)
      return false;
    }
  }

  /**
   * Load directory metadata and children for a given path.
   * Directory info is accessible via the directory getter.
   */
  public async loadDirectory(path: string, owner: string = this.address) {
    // [PHASE 1]: directory loading assuming not encrypted folder and files
    // [PHASE 2]: encrypted folder and children compatibility
    // [PHASE 3]: paginated children request handling
    if (!owner) throw new Error("Unable to load directory. No owner specified and no wallet connected.")
    const dir = (await this.client.queryClient.atlas.filetree.v1.treeNode({ path, owner })).node
    if (!dir) {
      // [TODO]: error handling
      throw new Error(`failed to get node ${path}, ${owner}`)
    }
    console.debug("[ATL.JS] <loadDirectory> dir =", dir)

    const children = (await this.client.queryClient.atlas.filetree.v1.treeNodeChildren({ path, owner: owner || this.address })).nodes ?? []
    console.debug("[ATL.JS] <loadDirectory> children =", dir)
    
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
    console.log("PATH:", newDir)
    this.emit(StorageHandlerEvent.NAV_DIR, newDir.path)
  }

  public async reloadDirectory() {
    await this.loadDirectory(this.directory.path)
  }

  public async selectAccount(address: string): Promise<boolean> {
    this.address = address
    if (!await this.loadSubscription()) {
      return false;
    }
    console.log("address", address)
    const drives: IAtlasDriveInfo[] = (await this.client.queryClient.atlas.filetree.v1.treeNodeChildren({ path: "", owner: address })).nodes
      .filter(n => n.nodeType == "drive")
      .map(d => JSON.parse(d.contents))
    
    if (!drives.length) {
      if (address != this.client.getCurrentAddress()) {
        throw new Error("This storage account does not have any files.")
      }
      else {
        this._drives = [await this.createDrive("home", true)]
        await this.loadDirectory("home")
      }
    }
    else {
      const defaultDrive = drives.find(d => d.isDefault) ?? drives[0]
      this._drives = drives
      await this.loadDirectory(defaultDrive.name)
    }
    return true;
  }

  public async createDrive(name: string, isDefault: boolean = false): Promise<IAtlasDriveInfo> {
    this._validateAccount()

    try {
      const contents: IAtlasDriveInfo = {
        name,
        size: 0,
        isDefault
      }
      const msg = MessageComposer.MsgPostNode(
        this.address,
        name,
        "drive",
        JSON.stringify(contents),
      )
      await this.client.signAndBroadcast([msg])
      return contents
    } catch (err) {
      console.error(`Failed to create drive "${name}".\n${err}`)
      throw err
    }
  }

  /**
   * Load active provider set.
   */
  public async loadProviders() {
    try {
      this._providers = (await this.client.queryClient.atlas.storage.v1.providers()).providers
    } catch (err) {
      // [TODO]: proper error handling
      // this is useless.. for now
      throw err;
    }
  }

  /**
   * Queue a file immediately and process in background
   */
  async queueFileAsync(
    file: File,
    options: IFileUploadOptions = {}
  ): Promise<void> {
    // add the file to the upload queue
    const queuedFile: IQueuedFile = {
      file,
      merkleRoot: new Uint8Array(),
      nonce: Math.floor(Math.random() * 2_147_483_647),
      replicas: options.replicas || DEFAULT_REPLICAS,
      encryption: options.encrypt ? options.encryptOpts ?? {} : undefined,
      status: 'idle'
    };
    this.queuedFiles.set(file.name, queuedFile);
    console.debug(`Queued File ${file.name}\n`, queuedFile)

    // start background file processing
    await this.processFile(file.name)
  }

  private async processFile(
    fileKey: string,
  ): Promise<void> {
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
      qfile.merkleRoot = tree.root
      console.debug("MROOT:", bytesToHex(qfile.merkleRoot))
      console.warn(tree.nodes)
      // console.log(tree)

      this.emit(FileProcessingEvent.MERKLE_BUILT, fileKey, {
        merkleRoot: bytesToHex(qfile.merkleRoot)
      });

      /// Phase 3: generate fid
      qfile.fid = await buildFid(qfile.merkleRoot, this.client.getCurrentAddress(), qfile.nonce)
      console.log("FID:", qfile.fid)
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
    }
  }

  /**
   * Update queued file's metadata
   * @param fileKey - file identifier (the original file name) 
   * @param metadata - file metadata
   */
  public updateQueuedFileMetadata(fileKey: string, metadata: Partial<IFileMetadata>) {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) throw new FileNotInQueue(`File ${fileKey} not found in upload queue!`);

    for (const [key, value] of Object.entries(metadata)) {
      queuedFile[key] = value
    }
    return;
  }

  /**
   * Update the status of a queued file
   * @param fileKey - file identifier
   * @param status - new file status
   */
  private updateQueuedFileStatus(fileKey: string, status: IQueuedFile['status']): void {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) throw new FileNotInQueue(`File ${fileKey} not found in upload queue!`);

    queuedFile.status = status;
    this.queuedFiles.set(fileKey, queuedFile);
    return;
  }

  /**
   * Start file upload
   * @param dir
   * @returns 
   */
  public async upload(dir: string = this._directory.path) {
    const creator = this.address
    if (!creator) throw new Error(`Wallet not connected`);
    // [TODO]: better way of determining this ^
    const now = Date.now();

    if (!this.queuedFiles.size) throw new Error("Cannot upload! Queue is empty.")

    try {
      const msgs_postFile: any = []
      const msgs_postNode: any = []
      msgs_postNode.push(await this._incrementDirectoryItemCount(dir, this.queuedFiles.size))

      this.stagedFiles.forEach(async (meta, key) => {
        const qfile = this.queuedFiles.get(key)

        const contents: ITreeNodeContents = {
          fid: qfile.fid,
          owner: creator,
          path: this.directory.path + '/' + qfile.fid,
          merkleRoot: bytesToHex(qfile.merkleRoot),
          dateUpdated: now,
          dateCreated: now,
          encrypted: qfile.encryption ? true : false,
          // [TBD]: can I do ...meta after name and type, and it won't overwrite them if undefined?
          meta: {
            ...meta,
            name: meta.name || qfile.file.name,
            type: qfile.file.type,
            size: qfile.file.size,
            lastModified: qfile.file.lastModified,
          },
        }

        msgs_postFile.push(
          MessageComposer.MsgPostFile(
            qfile.fid,
            creator,
            qfile.merkleRoot,
            qfile.file.size,
            qfile.replicas,
          )
        )
        msgs_postNode.push(
          MessageComposer.MsgPostNode(
            creator,
            `${dir}/${qfile.fid}`,
            "file",
            JSON.stringify(contents),
          )
        )
      })

      const txResult = await this.client.signAndBroadcast([...msgs_postFile, ...msgs_postNode])
      // console.log(txResult)

      this.queuedFiles.forEach(async (qfile) => {
        await UploadHelper.upload("https://api.oculux.io/api/v1", qfile.fid, qfile.file, null)
        this.queuedFiles.delete(qfile.file.name);
      })

      return;
    } catch (error) {
      throw new Error(`Failed to upload file: ${error}`);
    }
  }
  
  public async downloadFile(fid: string, basepath: string = this.directory.path): Promise<File> {
    const nodeDetails = await this.client.query.treeNode(basepath + '/' + fid, this.address)
    if (nodeDetails.nodeType != 'file') {
      throw new Error("this is not a file...")
    }

    const nodeContents = JSON.parse(nodeDetails.contents) as ITreeNodeContents
    const fileDetails = await this.client.query.file(fid)

    const raw = await this.download(fid, fileDetails.providers[0], nodeContents.meta.name, nodeContents.meta)

    return raw
  }


  private async download(fid: string, provider: string, fileName: string, fileMeta: FilePropertyBag): Promise<File> {
    try {
      const url = `${provider}/download/${fid}`
      const resp = await fetch(url, { method: 'GET' })
      const contentLength = resp.headers.get('Content-Length')
      if (resp.status !== 200) {
        throw new Error(`Status Message: ${resp.statusText}`)
      } else if (resp.body === null || !contentLength) {
        throw new Error(`Invalid response body`)
      } else {
        const chunks: Uint8Array<ArrayBuffer>[] = []
        const reader = resp.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          chunks.push(value)
        }
        return new File(chunks, fileName, fileMeta)
      }
    } catch (err) {
      throw err
    }
  }


  /*-------------------------------*/
  /* ===== DELETE OPERATIONS ===== */
  /*-------------------------------*/
  public async deleteFile(fid: string, basepath: string = this.directory.path): Promise<string> {
    const msgs: EncodeObject[] = [
      await this._incrementDirectoryItemCount(basepath, -1),
      ...this._genDeleteFileMessage(fid, basepath)
    ]
    const txResult = await this.client.signAndBroadcast(msgs)

    this.reloadDirectory()
    return txResult.hash
  }

  public async deleteFiles(fids: string[], basepath: string = this.directory.path): Promise<string> {
    const msgs: EncodeObject[] = [
      await this._incrementDirectoryItemCount(basepath, -1),
      ...fids.reduce((arr, fid) => {
        arr.push(...this._genDeleteFileMessage(fid, basepath))
        return arr
      }, [])
    ]
    const txResult = await this.client.signAndBroadcast(msgs)

    this.reloadDirectory()
    return txResult.hash
  }

  private _genDeleteFileMessage(fid: string, basepath: string): EncodeObject[] {
    return [
      MessageComposer.MsgDeleteNode(
        this.address,
        basepath + '/' + fid
      ),
      MessageComposer.MsgDeleteFile(
        this.address,
        fid
      )
    ]
  }

  public async deleteFolder(path: string = this.directory.path): Promise<string> {
    const msgs = [
      MessageComposer.MsgDeleteNode(
        this.address,
        path
      ),
    ]
    const txResult = await this.client.signAndBroadcast(msgs)

    if (path == this.directory.path) {
      this.loadDirectory(path.substring(0, path.lastIndexOf('/')))
    } else {
      this.reloadDirectory()
    }
    return txResult.hash
  }


  /**
   * List all queued files
   */
  listQueuedFiles(): IQueuedFile[] {
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

  private _validateAccount() {
    if (!this.address) throw new Error("Cannot perform this operation without connecting a wallet.")
    if (this.address != this.client.getCurrentAddress()) throw new Error("Cannot perform this operation on another account.")
  }

  /* ==== folder management ==== */
  async createDirectory(name: string, basepath: string = this._directory.path): Promise<string> {
    const creator = this.address
    const now = Date.now();
    const contents: IDirectoryNodeContents = {
      name,
      owner: creator,
      path: this.directory.path + '/' + name,
      itemCount: 0,
      dateUpdated: now,
      dateCreated: now
    }

    const msgs: EncodeObject[] = [
      await this._incrementDirectoryItemCount(basepath, 1),
      MessageComposer.MsgPostNode(creator, this.directory.path + '/' + name, "directory", JSON.stringify(contents))
    ]
    return (await this.client.signAndBroadcast(msgs)).hash
  }

  /* ==== subscription management ==== */
  async purchaseSubscription(bytes: number, days: number, address?: string): Promise<string> {
    address = address ?? this.address
    if (bytes < 1024**3) {
      throw Error("cannot do bytes less than 1GB")
    }
    if (days < 1) {
      throw Error("cannot do less than 1 day")
    }

    const msgs: EncodeObject[] = [
      {
        typeUrl: MsgBuyStorage.typeUrl,
        value: MsgBuyStorage.fromPartial({
          creator: this.address,
          receiver: address,
          duration: days,
          bytes: bytes,
          isDefault: false,
        })
      }
    ]
    const txResult = await this.client.signAndBroadcast(msgs)
    console.debug("[ATLAS.JS] Tx Result:", txResult)
    return txResult.hash
  }


  private async _incrementDirectoryItemCount(path: string, inc: number) {
    const folderNode = await this.client.query.treeNode(path, this.address)
    const folderContents: IDirectoryNodeContents = JSON.parse(folderNode.contents)
    folderContents.itemCount += inc

    return MessageComposer.MsgPostNode(
      this.address,
      `${path}`,
      folderNode.nodeType,
      JSON.stringify(folderContents),
    )
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
