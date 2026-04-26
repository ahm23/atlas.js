import EventEmitter from 'events';
import { EncodeObject } from '@cosmjs/proto-signing';
import { PrivateKey } from 'eciesjs';
import { AuthorityBundle } from '@atlas/atlas.js-protos/dist/types/atlas/filetree/v1/tree';
import { Provider } from '@atlas/atlas.js-protos/dist/types/atlas/storage/v1/provider';
import { StorageSubscription } from '@atlas/atlas.js-protos/dist/types/atlas/storage/v1/subscription';
import { MsgBuyStorage } from '@atlas/atlas.js-protos/dist/types/atlas/storage/v1/tx';

import { AtlasClient } from '@/atlas-client';
import { IStorageHandler } from '@/interfaces/classes/IStorageHandler';
import { IDirectory, IAtlasDriveInfo } from '@/interfaces';
import { IAesBundle } from '@/interfaces/encryption';
import { WalletType } from '@/wallets';
import { MessageComposer } from '@/messages/composer';
import { bytesToHex, stringToShaHex } from '@/utils/converters';
import { aesBlobCrypt, exportAesBundle, generateAesKey, importAesBundle } from '@/utils/crypto';
import { DEFAULT_ENCYRPTION_CHUNK_SIZE, DEFAULT_REPLICAS } from '@/utils/defaults';
import { buildFid } from '@/utils/hash';
import { buildFileMerkleTree } from '@/utils/merkletree';

import { CancellationException, FileNotInQueue } from './exceptions';
import { UploadHelper } from './upload-helper';
import {
  IDirectoryNodeContents,
  IEncryptionOptions,
  IFileMetadata,
  IFileUploadOptions,
  IQueuedFile,
  ITreeNodeContents,
} from './types';

const DEFAULT_STORAGE_GATEWAY = 'https://api.oculux.io/api/v1';
const SIGNER_SEED = 'Welcome to Atlas Protocol';

type QueueStatus = 'idle' | 'encrypting' | 'merkling' | 'ready' | 'uploading' | 'uploaded' | 'error';
type QueuedFile = IQueuedFile & {
  status: QueueStatus;
  metadata?: Partial<IFileMetadata>;
};

export enum FileProcessingEvent {
  ENCRYPTED = 'file:encrypted',
  MERKLE_BUILT = 'file:merkle-built',
  READY = 'file:ready',
  ERROR = 'file:error',
}

export enum StorageHandlerEvent {
  NAV_DIR = 'navigate-dir',
  NEW_SUB = 'subscription-loaded',
  NO_SUB = 'no-subscription',
}

export type StorageEvents = FileProcessingEvent | StorageHandlerEvent;

export class StorageHandler extends EventEmitter implements IStorageHandler {
  protected client: AtlasClient;
  protected queuedFiles: Map<string, QueuedFile> = new Map();
  protected stagedFiles: Map<string, IFileMetadata> = new Map();

  protected address: string;
  protected _activeSubscription?: StorageSubscription;
  private accessKeyPair?: PrivateKey;
  private accessKeyPairAddress?: string;

  protected _providers: Provider[] = [];
  private _drives: IAtlasDriveInfo[] = [];
  private _directory: IDirectory = createEmptyDirectory();

  constructor(client: AtlasClient) {
    super();
    this.client = client;
    this.address = client.getCurrentAddress();

    this.selectAccount = this.selectAccount.bind(this);
    this.client.on('walletConnected', this.selectAccount);
  }

  declare on: (event: StorageEvents | string, listener: (...args: any[]) => void) => this;
  declare emit: (event: StorageEvents | string, ...args: any[]) => boolean;

  static async new(client: AtlasClient, initialPath: string = 's'): Promise<StorageHandler> {
    const handler = new StorageHandler(client);
    await handler.loadProviders();
    await handler.loadSubscription();
    await handler.loadDirectory(initialPath);
    return handler;
  }

  public get ready(): boolean {
    return this._activeSubscription !== undefined;
  }

  public get directory(): IDirectory {
    return this._directory;
  }

  public get subscriptionId(): string {
    return this._activeSubscription?.id ?? '';
  }

  public get subscriptionStatus(): string {
    return this._activeSubscription?.status ?? '';
  }

  public get storageUsed(): number {
    return Number(this._activeSubscription?.spaceUsed ?? 0);
  }

  public get storageTotal(): number {
    return Number(this._activeSubscription?.spaceAvailable ?? 0);
  }

  public get providers(): Provider[] {
    return this._providers;
  }

  public async loadSubscription(id?: string): Promise<boolean> {
    try {
      this._activeSubscription = await this.client.query.subscription(this.address, id);
      this.emit(StorageHandlerEvent.NEW_SUB, this._activeSubscription);
      return true;
    } catch {
      this._activeSubscription = undefined;
      this.emit(StorageHandlerEvent.NO_SUB);
      return false;
    }
  }

  public async loadDirectory(path: string, owner: string = this.address): Promise<void> {
    if (!owner) {
      throw new Error('Unable to load directory. No owner specified and no wallet connected.');
    }

    const dir = (await this.client.queryClient.atlas.filetree.v1.treeNode({ path, owner })).node;
    if (!dir) {
      throw new Error(`Failed to load directory node "${path}" for owner "${owner}".`);
    }

    const children = (await this.client.queryClient.atlas.filetree.v1.treeNodeChildren({ path, owner })).nodes ?? [];
    const nextDirectory: IDirectory = {
      metadata: parseNodeContents(dir.contents, path),
      path,
      files: [],
      subdirs: [],
      objects: [],
    };

    for (const node of children) {
      if (node.nodeType === 'directory') {
        nextDirectory.subdirs.push(parseNodeContents(node.contents, joinPath(path, 'directory')));
      } else if (node.nodeType === 'file') {
        nextDirectory.files.push(parseNodeContents(node.contents, joinPath(path, 'file')));
      } else {
        nextDirectory.objects.push(node.contents);
      }
    }

    this._directory = nextDirectory;
    this.emit(StorageHandlerEvent.NAV_DIR, nextDirectory.path);
  }

  public async reloadDirectory(): Promise<void> {
    await this.loadDirectory(this.directory.path);
  }

  public async selectAccount(address: string): Promise<boolean> {
    const previousAddress = this.address;
    this.address = address;

    if (!address || address !== this.client.getCurrentAddress()) {
      return false;
    }

    if (previousAddress !== address) {
      this.accessKeyPair = undefined;
      this.accessKeyPairAddress = undefined;
    }

    if (!this.accessKeyPair || this.accessKeyPairAddress !== address) {
      await this.enableFullSigner();
    }

    if (!(await this.loadSubscription())) {
      return false;
    }

    const drives = await this.loadDrives(address);
    if (drives.length === 0) {
      this._drives = [await this.createDrive('home', true)];
      await this.loadDirectory('home');
      return true;
    }

    const defaultDrive = drives.find((drive) => drive.isDefault) ?? drives[0];
    this._drives = drives;
    await this.loadDirectory(defaultDrive.name);
    return true;
  }

  public async createDrive(name: string, isDefault: boolean = false): Promise<IAtlasDriveInfo> {
    this.validateCurrentAccount();

    const contents: IAtlasDriveInfo = {
      name,
      size: 0,
      isDefault,
    };

    const msg = MessageComposer.MsgPostNode(
      this.address,
      name,
      'drive',
      JSON.stringify(contents),
      [],
      [],
    );

    await this.client.signAndBroadcast([msg]);
    return contents;
  }

  public async loadProviders(): Promise<Provider[]> {
    this._providers = (await this.client.queryClient.atlas.storage.v1.providers()).providers ?? [];
    return this._providers;
  }

  public async queueFileAsync(file: File, options: IFileUploadOptions = {}): Promise<void> {
    const queuedFile: QueuedFile = {
      file,
      merkleRoot: new Uint8Array(),
      nonce: Math.floor(Math.random() * 2_147_483_647),
      replicas: options.replicas ?? DEFAULT_REPLICAS,
      encryption: options.encrypt ? options.encryptOpts ?? {} : undefined,
      status: 'idle',
    };

    this.queuedFiles.set(file.name, queuedFile);
    await this.processFile(file.name);
  }

  public updateQueuedFileMetadata(fileKey: string, metadata: Partial<IFileMetadata>): void {
    const queuedFile = this.getQueuedFile(fileKey);
    queuedFile.metadata = {
      ...queuedFile.metadata,
      ...metadata,
    };
    this.queuedFiles.set(fileKey, queuedFile);
  }

  public async upload(dir: string = this._directory.path): Promise<void> {
    this.validateCurrentAccount();

    if (this.queuedFiles.size === 0) {
      throw new Error('Cannot upload. Queue is empty.');
    }

    const queuedEntries = Array.from(this.queuedFiles.entries());
    const postFileMessages: EncodeObject[] = [];
    const postNodeMessages: EncodeObject[] = [
      await this.incrementDirectoryItemCount(dir, queuedEntries.length),
    ];

    for (const [fileKey, queuedFile] of queuedEntries) {
      this.assertReadyForUpload(fileKey, queuedFile);

      const contents = await this.buildFileNodeContents(dir, queuedFile);
      const authorityBundles = await this.buildAuthorityBundles(queuedFile);

      postFileMessages.push(
        MessageComposer.MsgPostFile(
          queuedFile.fid,
          this.address,
          queuedFile.merkleRoot,
          queuedFile.file.size,
          queuedFile.replicas,
          this.subscriptionId || undefined,
        ),
      );

      postNodeMessages.push(
        MessageComposer.MsgPostNode(
          this.address,
          contents.path,
          'file',
          JSON.stringify(contents),
          authorityBundles,
          authorityBundles,
        ),
      );
    }

    await this.client.signAndBroadcast([...postFileMessages, ...postNodeMessages]);
    await this.uploadQueuedFiles(queuedEntries);
    await this.reloadDirectory();
  }

  public async downloadFile(fid: string, basepath: string = this.directory.path): Promise<File> {
    const nodeDetails = await this.client.query.treeNode(joinPath(basepath, fid), this.address);
    if (!nodeDetails || nodeDetails.nodeType !== 'file') {
      throw new Error(`Node "${joinPath(basepath, fid)}" is not a file.`);
    }

    const nodeContents = parseNodeContents<ITreeNodeContents>(nodeDetails.contents, fid);
    const fileDetails = await this.client.query.file(fid);
    const provider = fileDetails.providers?.[0];
    if (!provider) {
      throw new Error(`File "${fid}" does not have an assigned storage provider.`);
    }

    const rawFile = await this.download(fid, provider, nodeContents.meta.name, nodeContents.meta);
    if (!nodeContents.encrypted) {
      return ensureNonEmptyFile(rawFile);
    }

    const aes = await this.extractAesKey(nodeDetails.viewers);
    return ensureNonEmptyFile(await decryptChunkedFile(rawFile, nodeContents.meta.name, nodeContents.meta, aes));
  }

  public async deleteFile(fid: string, basepath: string = this.directory.path): Promise<string> {
    this.validateCurrentAccount();

    const msgs: EncodeObject[] = [
      await this.incrementDirectoryItemCount(basepath, -1),
      ...this.buildDeleteFileMessages(fid, basepath),
    ];
    const txResult = await this.client.signAndBroadcast(msgs);

    await this.reloadDirectory();
    return txResult.hash;
  }

  public async deleteFiles(fids: string[], basepath: string = this.directory.path): Promise<string> {
    this.validateCurrentAccount();

    if (fids.length === 0) {
      throw new Error('Cannot delete files. No file ids were provided.');
    }

    const deleteMessages = fids.flatMap((fid) => this.buildDeleteFileMessages(fid, basepath));
    const msgs: EncodeObject[] = [
      await this.incrementDirectoryItemCount(basepath, -fids.length),
      ...deleteMessages,
    ];
    const txResult = await this.client.signAndBroadcast(msgs);

    await this.reloadDirectory();
    return txResult.hash;
  }

  public async deleteFolder(path: string = this.directory.path): Promise<string> {
    this.validateCurrentAccount();

    const txResult = await this.client.signAndBroadcast([
      MessageComposer.MsgDeleteNode(this.address, path),
    ]);

    if (path === this.directory.path) {
      await this.loadDirectory(parentPath(path));
    } else {
      await this.reloadDirectory();
    }

    return txResult.hash;
  }

  public listQueuedFiles(): IQueuedFile[] {
    return Array.from(this.queuedFiles.values());
  }

  public removeQueuedFile(fileKey: string): void {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) return;

    queuedFile.abortController?.abort();
    this.queuedFiles.delete(fileKey);
  }

  public clearQueuedFiles(): void {
    for (const queuedFile of this.queuedFiles.values()) {
      queuedFile.abortController?.abort();
    }
    this.queuedFiles.clear();
  }

  public async createDirectory(name: string, basepath: string = this._directory.path): Promise<string> {
    this.validateCurrentAccount();

    const now = Date.now();
    const path = joinPath(basepath, name);
    const contents: IDirectoryNodeContents = {
      name,
      owner: this.address,
      path,
      itemCount: 0,
      dateUpdated: now,
      dateCreated: now,
    };

    const msgs: EncodeObject[] = [
      await this.incrementDirectoryItemCount(basepath, 1),
      MessageComposer.MsgPostNode(this.address, path, 'directory', JSON.stringify(contents), [], []),
    ];

    const txResult = await this.client.signAndBroadcast(msgs);
    await this.loadDirectory(basepath);
    return txResult.hash;
  }

  public async purchaseSubscription(bytes: number, days: number, address: string = this.address): Promise<string> {
    this.validateCurrentAccount();

    if (bytes < 1024 ** 3) {
      throw new Error('Cannot purchase less than 1GB of storage.');
    }
    if (days < 1) {
      throw new Error('Cannot purchase storage for less than 1 day.');
    }

    const msgs: EncodeObject[] = [
      {
        typeUrl: MsgBuyStorage.typeUrl,
        value: MsgBuyStorage.fromPartial({
          creator: this.address,
          receiver: address,
          duration: days,
          bytes,
          isDefault: false,
        }),
      },
    ];

    const txResult = await this.client.signAndBroadcast(msgs);
    await this.loadSubscription();
    return txResult.hash;
  }

  protected async extractAesKey(permissions: AuthorityBundle[]): Promise<IAesBundle> {
    const keyPair = this.requireAccessKeyPair();
    const userAuth = permissions.find((obj) => obj.address === this.client.getCurrentAddress());
    if (!userAuth) {
      throw new Error('Not an authorized viewer.');
    }

    return importAesBundle(keyPair, userAuth.secret);
  }

  private async enableFullSigner(): Promise<void> {
    const selectedWallet = this.client.getWalletType();
    const address = this.client.getCurrentAddress();
    const chainId = this.client.getChainId();

    let signature: string;
    switch (selectedWallet) {
      case WalletType.KEPLR:
        if (!window.keplr) throw new Error('Missing Keplr wallet extension.');
        signature = (await window.keplr.signArbitrary(chainId, address, SIGNER_SEED)).signature;
        break;
      case WalletType.LEAP:
        if (!window.leap) throw new Error('Missing Leap wallet extension.');
        signature = (await window.leap.signArbitrary(chainId, address, SIGNER_SEED)).signature;
        break;
      default:
        throw new Error('A Keplr or Leap wallet is required to initialize StorageHandler signing.');
    }

    this.accessKeyPair = PrivateKey.fromHex(await stringToShaHex(signature));
    this.accessKeyPairAddress = address;
  }

  private async loadDrives(address: string): Promise<IAtlasDriveInfo[]> {
    const nodes = (await this.client.queryClient.atlas.filetree.v1.treeNodeChildren({ path: '', owner: address })).nodes ?? [];
    return nodes
      .filter((node) => node.nodeType === 'drive')
      .map((node) => parseNodeContents<IAtlasDriveInfo>(node.contents, 'drive'));
  }

  private async processFile(fileKey: string): Promise<void> {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) return;

    const processStartedAt = performance.now();
    const abortController = new AbortController();
    queuedFile.abortController = abortController;
    this.queuedFiles.set(fileKey, queuedFile);

    try {
      if (queuedFile.encryption) {
        this.updateQueuedFileStatus(fileKey, 'encrypting');
        queuedFile.encryption.aes = queuedFile.encryption.aes ?? (await generateAesKey());
        const encryptStartedAt = performance.now();
        console.debug(
          `[StorageHandler] Encrypting "${fileKey}" (${queuedFile.file.size} bytes, chunkSize=${queuedFile.encryption.chunkSize ?? DEFAULT_ENCYRPTION_CHUNK_SIZE})`,
        );
        queuedFile.file = await encryptFile(queuedFile.file, queuedFile.encryption, abortController.signal);
        console.debug(
          `[StorageHandler] Encrypted "${fileKey}" in ${formatDuration(performance.now() - encryptStartedAt)} (${queuedFile.file.size} encrypted bytes)`,
        );
        this.emit(FileProcessingEvent.ENCRYPTED, fileKey, { fileSize: queuedFile.file.size });
      }

      this.updateQueuedFileStatus(fileKey, 'merkling');
      const merkleStartedAt = performance.now();
      console.debug(`[StorageHandler] Building merkle tree for "${fileKey}" (${queuedFile.file.size} bytes)`);
      const tree = await buildFileMerkleTree(queuedFile.file, abortController.signal);
      console.debug(
        `[StorageHandler] Built merkle tree for "${fileKey}" in ${formatDuration(performance.now() - merkleStartedAt)} (${tree.nodes.length} nodes)`,
      );
      queuedFile.merkleRoot = tree.root;
      this.emit(FileProcessingEvent.MERKLE_BUILT, fileKey, { merkleRoot: bytesToHex(queuedFile.merkleRoot) });

      queuedFile.fid = await buildFid(queuedFile.merkleRoot, this.address, queuedFile.nonce);
      this.queuedFiles.set(fileKey, queuedFile);
      throwIfAborted(abortController.signal);

      this.updateQueuedFileStatus(fileKey, 'ready');
      console.debug(`[StorageHandler] Processed "${fileKey}" in ${formatDuration(performance.now() - processStartedAt)}`);
      this.emit(FileProcessingEvent.READY, fileKey);
    } catch (error) {
      console.debug(`[StorageHandler] Failed processing "${fileKey}" after ${formatDuration(performance.now() - processStartedAt)}`);
      this.handleFileProcessingError(fileKey, error);
    }
  }

  private handleFileProcessingError(fileKey: string, error: unknown): void {
    if (error instanceof CancellationException || this.queuedFiles.get(fileKey)?.abortController?.signal.aborted) {
      this.queuedFiles.delete(fileKey);
      return;
    }

    if (!this.queuedFiles.has(fileKey)) {
      return;
    }

    this.updateQueuedFileStatus(fileKey, 'error');
    const message = error instanceof Error ? error.message : 'Unknown file processing error.';
    this.emit(FileProcessingEvent.ERROR, fileKey, message);
  }

  private updateQueuedFileStatus(fileKey: string, status: QueueStatus): void {
    const queuedFile = this.getQueuedFile(fileKey);
    queuedFile.status = status;
    this.queuedFiles.set(fileKey, queuedFile);
  }

  private getQueuedFile(fileKey: string): QueuedFile {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) {
      throw new FileNotInQueue(`File ${fileKey} not found in upload queue.`);
    }
    return queuedFile;
  }

  private assertReadyForUpload(fileKey: string, queuedFile: QueuedFile): asserts queuedFile is QueuedFile & { fid: string } {
    if (queuedFile.status !== 'ready' || !queuedFile.fid) {
      throw new Error(`File ${fileKey} is not ready for upload.`);
    }
  }

  private async buildFileNodeContents(dir: string, queuedFile: QueuedFile & { fid: string }): Promise<ITreeNodeContents> {
    const now = Date.now();
    const file = queuedFile.file;

    return {
      fid: queuedFile.fid,
      owner: this.address,
      path: joinPath(dir, queuedFile.fid),
      merkleRoot: bytesToHex(queuedFile.merkleRoot),
      dateUpdated: now,
      dateCreated: now,
      encrypted: queuedFile.encryption !== undefined,
      meta: {
        ...queuedFile.metadata,
        name: queuedFile.metadata?.name ?? file.name,
        type: queuedFile.metadata?.type ?? file.type,
        size: queuedFile.metadata?.size ?? file.size,
        lastModified: queuedFile.metadata?.lastModified ?? file.lastModified,
      },
    };
  }

  private async buildAuthorityBundles(queuedFile: QueuedFile): Promise<AuthorityBundle[]> {
    if (!queuedFile.encryption) {
      return [];
    }

    const aes = queuedFile.encryption.aes;
    if (!aes) {
      throw new Error(`Missing encryption key for file "${queuedFile.file.name}".`);
    }

    const keyPair = this.requireAccessKeyPair();
    return [
      {
        address: this.address,
        secret: await exportAesBundle(keyPair.publicKey.toHex(), aes),
      },
    ];
  }

  private async uploadQueuedFiles(queuedEntries: Array<[string, QueuedFile]>): Promise<void> {
    await Promise.all(
      queuedEntries.map(async ([fileKey, queuedFile]) => {
        this.updateQueuedFileStatus(fileKey, 'uploading');
        const result = await UploadHelper.upload(DEFAULT_STORAGE_GATEWAY, queuedFile.fid, queuedFile.file, null);
        if (!result.success) {
          this.updateQueuedFileStatus(fileKey, 'error');
          throw new Error(result.message ?? `Failed to upload file "${fileKey}".`);
        }

        this.updateQueuedFileStatus(fileKey, 'uploaded');
        this.queuedFiles.delete(fileKey);
      }),
    );
  }

  private async download(fid: string, provider: string, fileName: string, fileMeta: FilePropertyBag): Promise<File> {
    await this.client.query.provider(provider);
    const response = await fetch(`${DEFAULT_STORAGE_GATEWAY}/download/${fid}`, { method: 'GET' });

    if (!response.ok) {
      throw new Error(`Failed to download file "${fid}": ${response.status} ${response.statusText}`);
    }

    const body = await response.blob();
    return new File([body], fileName, fileMeta);
  }

  private buildDeleteFileMessages(fid: string, basepath: string): EncodeObject[] {
    return [
      MessageComposer.MsgDeleteNode(this.address, joinPath(basepath, fid)),
      MessageComposer.MsgDeleteFile(this.address, fid),
    ];
  }

  private async incrementDirectoryItemCount(path: string, inc: number): Promise<EncodeObject> {
    const folderNode = await this.client.query.treeNode(path, this.address);
    if (!folderNode) {
      throw new Error(`Directory "${path}" does not exist.`);
    }

    const folderContents = parseNodeContents<IDirectoryNodeContents>(folderNode.contents, path);
    folderContents.itemCount = Math.max(0, (folderContents.itemCount ?? 0) + inc);
    folderContents.dateUpdated = Date.now();

    return MessageComposer.MsgPostNode(
      this.address,
      path,
      folderNode.nodeType,
      JSON.stringify(folderContents),
      folderNode.viewers,
      folderNode.editors,
    );
  }

  private validateCurrentAccount(): void {
    if (!this.address) {
      throw new Error('Cannot perform this operation without connecting a wallet.');
    }
    if (this.address !== this.client.getCurrentAddress()) {
      throw new Error('Cannot perform this operation on another account.');
    }
  }

  private requireAccessKeyPair(): PrivateKey {
    if (!this.accessKeyPair) {
      throw new Error('Storage signer has not been initialized.');
    }
    return this.accessKeyPair;
  }
}

function createEmptyDirectory(): IDirectory {
  return {
    path: '',
    files: [],
    subdirs: [],
    objects: [],
    metadata: {},
  };
}

function parseNodeContents<T>(contents: string, path: string): T {
  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new Error(`Failed to parse filetree contents for "${path}": ${error}`);
  }
}

function joinPath(basepath: string, child: string): string {
  if (!basepath) return child;
  if (!child) return basepath;
  return `${basepath.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancellationException('File processing cancelled.');
  }
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds.toFixed(1)}ms`
    : `${(milliseconds / 1000).toFixed(2)}s`;
}

async function encryptFile(file: File, opts: IEncryptionOptions, signal: AbortSignal): Promise<File> {
  if (!opts.aes) {
    throw new Error('AES key and iv are required in the encryption options.');
  }

  const encryptedBytes: Blob[] = [];
  const chunkSize = opts.chunkSize ?? DEFAULT_ENCYRPTION_CHUNK_SIZE;

  for (let i = 0; i < file.size; i += chunkSize) {
    throwIfAborted(signal);
    const blobChunk = file.slice(i, i + chunkSize);
    encryptedBytes.push(
      new Blob([(blobChunk.size + 16).toString().padStart(8, '0')]),
      await aesBlobCrypt(blobChunk, opts.aes, 'encrypt'),
    );
  }

  return new File(encryptedBytes, file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

async function decryptChunkedFile(file: File, fileName: string, fileMeta: FilePropertyBag, aes: IAesBundle): Promise<File> {
  const parts: Blob[] = [];

  for (let cursor = 0; cursor < file.size;) {
    const headerEnd = cursor + 8;
    const segmentSize = Number(await file.slice(cursor, headerEnd).text());
    if (!Number.isFinite(segmentSize) || segmentSize < 1) {
      throw new Error('Encrypted file is malformed.');
    }

    const segmentEnd = headerEnd + segmentSize;
    parts.push(await aesBlobCrypt(file.slice(headerEnd, segmentEnd), aes, 'decrypt'));
    cursor = segmentEnd;
  }

  return new File(parts, fileName, fileMeta);
}

function ensureNonEmptyFile(file: File): File {
  if (file.size === 0) {
    throw new Error('File is empty.');
  }
  return file;
}
