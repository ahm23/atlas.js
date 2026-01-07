import { defaultEncryptionChunkSize } from '@/utils/defaults';
import { 
  FileOptions, 
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
import { IFolderContents } from '@/interfaces/types/IFolderContents';
import { QueryFileTreeNodeResponse } from '@atlas/atlas.js-protos/dist/types/nebulix/filetree/v1/query';
import { IFolderMeta } from '@/interfaces/types/IFolderMeta';

export class StorageHandler implements IStorageHandler {
  private client: AtlasClient;
  private queuedFiles: Map<string, QueuedFile> = new Map();
  private address;

  private directory: IFolderContents;

  constructor(client: AtlasClient) {
    this.client = client;
    this.address = client.getCurrentAddress();
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

  async upload() {
    
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
      throw new Error(`Failed to upload file: ${error.message}`);
    }
  }

  /**
   * Get directory contents for a given path
   */
  async getDirectory(path: string, owner?: string) {
    // const res = await this.client.query.nebulix.filetree.v1.fileTreePaths({ owner: this.address, basepath: "home" })
    // console.log(res)

    const nodes = (await this.client.query.nebulix.filetree.v1.fileTreeNodes({ path, owner: owner || this.address })).nodes
    
    let folders: IFolderMeta[] = []
    let files = []
    let objects = []

    for (const node of nodes) {
      switch (node.nodeType) {
        case "directory":
          folders.push(JSON.parse(node.contents))
          break;
        case "file":
          files.push(JSON.parse(node.contents))
          break;
        default:
          objects.push(node.contents)
      }
    }

    if (res.nodeType == "directory") {
      return JSON.parse(res.contents) as IFolderContents
    } 
    else {
      console.error("Not a directory")
    }
  }

  async loadDirectory(path: string) {
    const contents = await this.getDirectory(path, this.address)
    
    for (const file of contents.files) {

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
