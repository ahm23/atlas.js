import EventEmitter from 'events';
import { EncodeObject } from '@cosmjs/proto-signing';
import { PrivateKey } from 'eciesjs';
import { AuthorityBundle, TreeNode } from '@atlas/atlas.js-protos/dist/types/atlas/filetree/v1/tree';
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

export class DirectoryLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryLoadError';
  }
}

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

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

  protected _address: string;
  protected _activeSubscription?: StorageSubscription;
  private accessKeyPair?: PrivateKey;
  private accessKeyPairAddress?: string;
  private _isAuthorized = true;

  protected _providers: Provider[] = [];
  private _drives: IAtlasDriveInfo[] = [];
  private _directory: IDirectory = createEmptyDirectory();

  /**
   * Create a storage handler bound to an Atlas client and its active wallet.
   *
   * The handler listens for wallet connection changes so it can reload account
   * storage state when the user switches accounts.
   */
  constructor(client: AtlasClient) {
    super();
    this.client = client;
    this._address = client.getCurrentAddress();

    this.selectAccount = this.selectAccount.bind(this);
    this.client.on('walletConnected', this.selectAccount);
  }

  declare on: (event: StorageEvents | string, listener: (...args: any[]) => void) => this;
  declare emit: (event: StorageEvents | string, ...args: any[]) => boolean;

  /**
   * Build and initialize a storage handler in one call.
   *
   * This loads providers, attempts to load the active subscription, and opens
   * the requested initial directory.
   */
  static async new(client: AtlasClient, initialPath: string = 's'): Promise<StorageHandler> {
    const handler = new StorageHandler(client);
    await handler.loadProviders();
    await handler.loadSubscription();
    await handler.loadDirectory(initialPath);
    return handler;
  }

  /**
   * True when an active storage subscription is loaded.
   */
  public get ready(): boolean {
    return this._activeSubscription !== undefined;
  }

  /**
   * True when the selected storage account matches the connected wallet.
   */
  public get isAuthorized(): boolean {
    return this._isAuthorized;
  }

  /**
   * Current directory metadata and children.
   */
  public get directory(): IDirectory {
    return this._directory;
  }

  /**
   * Active subscription id, or an empty string when no subscription is loaded.
   */
  public get subscriptionId(): string {
    return this._activeSubscription?.id ?? '';
  }

  /**
   * Active subscription status, or an empty string when no subscription is loaded.
   */
  public get subscriptionStatus(): string {
    return this._activeSubscription?.status ?? '';
  }

  /**
   * Number of bytes currently used by the active subscription.
   */
  public get storageUsed(): number {
    return Number(this._activeSubscription?.spaceUsed ?? 0);
  }

  /**
   * Number of bytes available in the active subscription.
   */
  public get storageTotal(): number {
    return Number(this._activeSubscription?.spaceAvailable ?? 0);
  }

  /**
   * Loaded storage providers for the current chain state.
   */
  public get providers(): Provider[] {
    return this._providers;
  }

  /**
   * Load a subscription for the current handler address.
   *
   * Emits `NEW_SUB` when found and `NO_SUB` when the query fails.
   */
  public async loadSubscription(id?: string): Promise<void> {
    this.validateAuthority();

    try {
      this._activeSubscription = await this.client.query.subscription(this._address, id);
      this.emit(StorageHandlerEvent.NEW_SUB, this._activeSubscription);
    } catch (error) {
      this._activeSubscription = undefined;
      this.emit(StorageHandlerEvent.NO_SUB);
      throw new SubscriptionError(`Failed to load subscription for "${this._address}": ${errorMessage(error)}`);
    }
  }

  /**
   * Load a filetree directory and its direct children.
   *
   * The loaded directory becomes available through the `directory` getter and
   * a `NAV_DIR` event is emitted with the new path.
   *
   * Throws `TypeError` for invalid arguments and `DirectoryLoadError` when the
   * directory cannot be loaded or parsed.
   */
  public async loadDirectory(path: string, owner: string = this._address): Promise<void> {
    if (!owner) {
      throw new TypeError('Unable to load directory. No owner specified and no wallet connected.');
    }

    const dir = await this.client.query.treeNode(path, owner);
    if (!dir) {
      throw new DirectoryLoadError(`Directory node "${path}" was not found for owner "${owner}".`);
    }
    if (!isDirectoryNode(dir)) {
      throw new DirectoryLoadError(`Filetree node "${path}" is a "${dir.nodeType}" node, not a directory.`);
    }

    const nextDirectory: IDirectory = {
      metadata: parseNodeContents(dir.contents, path),
      path,
      files: [],
      subdirs: [],
      objects: [],
    };
    const children: TreeNode[] = await this.client.query.treeNodeChildren(path, owner) ?? [];
    for (const [index, node] of children.entries()) {
      try {
        if (node.nodeType === 'directory') {
          nextDirectory.subdirs.push(parseNodeContents(node.contents, `${path}/children[${index}]:directory`));
        } else if (node.nodeType === 'file') {
          nextDirectory.files.push(parseNodeContents(node.contents, `${path}/children[${index}]:file`));
        } else {
          nextDirectory.objects.push(node.contents);
        }
      } catch (error) {
        console.warn(`Child ${index} of directory "${path}" has invalid "${node.nodeType}" contents:\n ${node.contents}`);
      }
    }

    this._directory = nextDirectory;
    this.emit(StorageHandlerEvent.NAV_DIR, nextDirectory.path);
  }

  /**
   * Reload the currently selected directory from chain state.
   */
  public async reloadDirectory(): Promise<void> {
    await this.loadDirectory(this.directory.path);
  }

  /**
   * Switch the handler to a storage account.
   *
   * Selecting the connected wallet enables authorized access. Selecting another
   * address loads that account without enabling the local access key.
   *
   * Throws `TypeError` for invalid account arguments and `AccountError`
   * when the selected account has no files to view.
   */
  public async selectAccount(address: string): Promise<void> {
    if (!address) {
      throw new TypeError('Unable to select account. No address specified.');
    }
    this._isAuthorized = address === this.client.getCurrentAddress();
    this._address = address;

    if (this._isAuthorized && (!this.accessKeyPair || this.accessKeyPairAddress !== address)) {
      await this.enableFullSigner();
    }

    if (this._isAuthorized) {
      await this.loadSubscription();
    }

    const drives = await this.findDrives(address);
    if (drives.length === 0) {
      if (!this._isAuthorized) {
        throw new AccountError(`Storage account "${address}" does not have any drives to view.`);
      }
      this._drives = [await this.createDrive('home', true)];
      await this.loadDirectory('home');
      return
    } else {
      const defaultDrive = drives.find((drive) => drive.isDefault) ?? drives[0];
      this._drives = drives;
      await this.loadDirectory(defaultDrive.name);
    }
  }

  /**
   * Find all drive nodes owned by an address.
   */
  private async findDrives(address: string): Promise<IAtlasDriveInfo[]> {
    const nodes = await this.client.query.treeNodeChildren('', address) ?? [];
    // [TODO]: logic will change once encryting node contents is implemented
    return nodes
      .filter((node) => node.nodeType === 'drive')
      .map((node) => parseNodeContents<IAtlasDriveInfo>(node.contents, 'drive'));
  }

  /**
   * Create a top-level drive node for the active account.
   */
  public async createDrive(name: string, isDefault: boolean = false): Promise<IAtlasDriveInfo> {
    this.validateAuthority();

    const contents: IAtlasDriveInfo = {
      name,
      size: 0,
      isDefault,
    };

    const msg = MessageComposer.MsgPostNode(
      this._address,
      name,
      'drive',
      JSON.stringify(contents),
      [],
      [],
    );

    await this.client.signAndBroadcast([msg]);
    return contents;
  }

  /**
   * Load the active storage provider set from the chain.
   */
  public async loadProviders(): Promise<Provider[]> {
    this._providers = (await this.client.queryClient.atlas.storage.v1.providers()).providers ?? [];
    return this._providers;
  }

  /**
   * Add a file to the local queue and process it into upload-ready metadata.
   *
   * Processing may encrypt the file, build its Merkle root, and derive its FID.
   * File processing events are emitted as each phase completes.
   */
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

  /**
   * Merge caller-provided metadata into an already queued file.
   */
  public updateQueuedFileMetadata(fileKey: string, metadata: Partial<IFileMetadata>): void {
    const queuedFile = this.getQueuedFile(fileKey);
    queuedFile.metadata = {
      ...queuedFile.metadata,
      ...metadata,
    };
    this.queuedFiles.set(fileKey, queuedFile);
  }

  /**
   * Commit queued files on-chain and upload their bytes to the storage gateway.
   *
   * Every queued file must already be in the `ready` state. The directory item
   * count is updated in the same transaction as the file and filetree nodes.
   */
  public async upload(dir: string = this._directory.path): Promise<void> {
    this.validateAuthority();

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
          this._address,
          queuedFile.merkleRoot,
          queuedFile.file.size,
          queuedFile.replicas,
          this.subscriptionId || undefined,
        ),
      );

      postNodeMessages.push(
        MessageComposer.MsgPostNode(
          this._address,
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

  /**
   * Download a file by FID from one of its assigned storage providers.
   *
   * Encrypted files are decrypted with the viewer authority bundle stored on
   * the filetree node.
   */
  public async downloadFile(fid: string, basepath: string = this.directory.path): Promise<File> {
    const nodeDetails = await this.client.query.treeNode(joinPath(basepath, fid), this._address);
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

  /**
   * Delete one file from storage and its filetree node.
   *
   * Returns the transaction hash after refreshing the current directory.
   */
  public async deleteFile(fid: string, basepath: string = this.directory.path): Promise<string> {
    this.validateAuthority();

    const msgs: EncodeObject[] = [
      await this.incrementDirectoryItemCount(basepath, -1),
      ...this.buildDeleteFileMessages(fid, basepath),
    ];
    const txResult = await this.client.signAndBroadcast(msgs);

    await this.reloadDirectory();
    return txResult.hash;
  }

  /**
   * Delete multiple files from storage and their filetree nodes.
   *
   * Returns the transaction hash after refreshing the current directory.
   */
  public async deleteFiles(fids: string[], basepath: string = this.directory.path): Promise<string> {
    this.validateAuthority();

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

  /**
   * Delete a directory node from the filetree.
   *
   * If the deleted directory is currently open, the handler navigates to its
   * parent directory. Otherwise the current directory is reloaded.
   */
  public async deleteFolder(path: string = this.directory.path): Promise<string> {
    this.validateAuthority();

    const txResult = await this.client.signAndBroadcast([
      MessageComposer.MsgDeleteNode(this._address, path),
    ]);

    if (path === this.directory.path) {
      await this.loadDirectory(parentPath(path));
    } else {
      await this.reloadDirectory();
    }

    return txResult.hash;
  }

  /**
   * Return a snapshot of all queued files.
   */
  public listQueuedFiles(): IQueuedFile[] {
    return Array.from(this.queuedFiles.values());
  }

  /**
   * Remove a file from the queue and abort processing when possible.
   */
  public removeQueuedFile(fileKey: string): void {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) return;

    queuedFile.abortController?.abort();
    this.queuedFiles.delete(fileKey);
  }

  /**
   * Abort and remove all queued files.
   */
  public clearQueuedFiles(): void {
    for (const queuedFile of this.queuedFiles.values()) {
      queuedFile.abortController?.abort();
    }
    this.queuedFiles.clear();
  }

  /**
   * Create a child directory under the supplied base path.
   *
   * Returns the transaction hash after reloading the parent directory.
   */
  public async createDirectory(name: string, basepath: string = this._directory.path): Promise<string> {
    this.validateAuthority();

    const now = Date.now();
    const path = joinPath(basepath, name);
    const contents: IDirectoryNodeContents = {
      name,
      owner: this._address,
      path,
      itemCount: 0,
      dateUpdated: now,
      dateCreated: now,
    };

    const msgs: EncodeObject[] = [
      await this.incrementDirectoryItemCount(basepath, 1),
      MessageComposer.MsgPostNode(this._address, path, 'directory', JSON.stringify(contents), [], []),
    ];

    const txResult = await this.client.signAndBroadcast(msgs);
    await this.loadDirectory(basepath);
    return txResult.hash;
  }

  /**
   * Purchase a storage subscription for the active account or a receiver.
   *
   * The minimum purchase is one gigabyte for one day.
   */
  public async purchaseSubscription(bytes: number, days: number, address: string = this._address): Promise<string> {
    this.validateAuthority();

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
          creator: this._address,
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

  /**
   * Decrypt the AES bundle granted to the connected wallet.
   */
  protected async extractAesKey(permissions: AuthorityBundle[]): Promise<IAesBundle> {
    const keyPair = this.requireAccessKeyPair();
    const userAuth = permissions.find((obj) => obj.address === this.client.getCurrentAddress());
    if (!userAuth) {
      throw new Error('Not an authorized viewer.');
    }

    return importAesBundle(keyPair, userAuth.secret);
  }

  /**
   * Ask the wallet to sign a stable seed and derive the local ECIES keypair.
   *
   * The derived keypair is used only to wrap and unwrap file encryption keys.
   */
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

  /**
   * Prepare one queued file for upload.
   *
   * This runs optional encryption, Merkle tree construction, and FID derivation,
   * updating queue status and emitting progress events as it goes.
   */
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

      queuedFile.fid = await buildFid(queuedFile.merkleRoot, this._address, queuedFile.nonce);
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

  /**
   * Normalize file processing failures into queue status and events.
   */
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

  /**
   * Update a queued file status while preserving observable map updates.
   */
  private updateQueuedFileStatus(fileKey: string, status: QueueStatus): void {
    const queuedFile = this.getQueuedFile(fileKey);
    queuedFile.status = status;
    this.queuedFiles.set(fileKey, queuedFile);
  }

  /**
   * Fetch a queued file or throw a typed queue error.
   */
  private getQueuedFile(fileKey: string): QueuedFile {
    const queuedFile = this.queuedFiles.get(fileKey);
    if (!queuedFile) {
      throw new FileNotInQueue(`File ${fileKey} not found in upload queue.`);
    }
    return queuedFile;
  }

  /**
   * Assert a queued file has completed preprocessing and has a FID.
   */
  private assertReadyForUpload(fileKey: string, queuedFile: QueuedFile): asserts queuedFile is QueuedFile & { fid: string } {
    if (queuedFile.status !== 'ready' || !queuedFile.fid) {
      throw new Error(`File ${fileKey} is not ready for upload.`);
    }
  }

  /**
   * Build the JSON contents stored in the filetree node for an uploaded file.
   */
  private async buildFileNodeContents(dir: string, queuedFile: QueuedFile & { fid: string }): Promise<ITreeNodeContents> {
    const now = Date.now();
    const file = queuedFile.file;

    return {
      fid: queuedFile.fid,
      owner: this._address,
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

  /**
   * Build viewer/editor authority bundles for encrypted files.
   *
   * Unencrypted files do not need authority bundles.
   */
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
        address: this._address,
        secret: await exportAesBundle(keyPair.publicKey.toHex(), aes),
      },
    ];
  }

  /**
   * Upload all queued file bytes to the storage gateway.
   *
   * Files are removed from the queue only after their gateway upload succeeds.
   */
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

  /**
   * Fetch raw file bytes from the configured storage gateway.
   */
  private async download(fid: string, provider: string, fileName: string, fileMeta: FilePropertyBag): Promise<File> {
    await this.client.query.provider(provider);
    const response = await fetch(`${DEFAULT_STORAGE_GATEWAY}/download/${fid}`, { method: 'GET' });

    if (!response.ok) {
      throw new Error(`Failed to download file "${fid}": ${response.status} ${response.statusText}`);
    }

    const body = await response.blob();
    return new File([body], fileName, fileMeta);
  }

  /**
   * Create the chain messages needed to remove a file and its tree node.
   */
  private buildDeleteFileMessages(fid: string, basepath: string): EncodeObject[] {
    return [
      MessageComposer.MsgDeleteNode(this._address, joinPath(basepath, fid)),
      MessageComposer.MsgDeleteFile(this._address, fid),
    ];
  }

  /**
   * Build a replacement directory node with an adjusted child item count.
   */
  private async incrementDirectoryItemCount(path: string, inc: number): Promise<EncodeObject> {
    const folderNode = await this.client.query.treeNode(path, this._address);
    if (!folderNode) {
      throw new Error(`Directory "${path}" does not exist.`);
    }

    const folderContents = parseNodeContents<IDirectoryNodeContents>(folderNode.contents, path);
    folderContents.itemCount = Math.max(0, (folderContents.itemCount ?? 0) + inc);
    folderContents.dateUpdated = Date.now();

    return MessageComposer.MsgPostNode(
      this._address,
      path,
      folderNode.nodeType,
      JSON.stringify(folderContents),
      folderNode.viewers,
      folderNode.editors,
    );
  }

  /**
   * Ensure the handler is operating on the currently connected wallet account.
   */
  private validateAuthority(): void {
    if (!this.isAuthorized) {
      throw new AccountError(`Account ${this.client.getCurrentAddress()} is not authorized to perform this action.`);
    }
  }

  /**
   * Return the derived storage keypair or throw if signing has not been enabled.
   */
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

function isDirectoryNode(node: TreeNode): boolean {
  return node.nodeType === 'directory' || node.nodeType === 'drive';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseNodeContents<T>(contents: string, path: string): T {
  // [TODO]: logic will change once encryting node contents is implemented, view access bundle will be passed as arg too
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
