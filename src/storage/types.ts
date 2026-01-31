import { IAesBundle } from "@/interfaces/encryption";
import { IFileMeta } from "@/interfaces/metadata";
import { aesBlobCrypt, generateAesKey } from "@/utils/crypto";
import { DEFAULT_ENCYRPTION_CHUNK_SIZE } from "@/utils/defaults";
import { buildFileMerkleTree } from "@/utils/merkletree";

export interface IFileUploadOptions {
  replicas?: number
  encrypt?: boolean
  encryptOpts?: IEncryptionOptions
}

export interface IEncryptionOptions {
  chunkSize?: number;
  aes?: IAesBundle;
}

export interface IFileMetadata {
  name: string,
  description?: string,
  [k: string]: any
}

export interface QueuedFile {
  file: File

  fid?: string
  merkleRoot: Uint8Array
  nonce: number

  replicas: number
  encryption?: IEncryptionOptions

  metadata: IFileMetadata
  status: string
  abortController?: AbortController;
}

export interface IFileNodeContents {
  fid: string
  owner: string
  name: string
  size: number
  type: string
  lastModified: number

  merkleRoot: string
  lastUpdated: number
  dateCreated: number
}

export interface UploadResult {
  fileId: string;
  transactionHash: string;
  storageNodes: string[];
  timestamp: number;
}

interface AccessMap {
  [k: string]: string
}

// export class AtlasFile {
//   private _file: File;
//   private _merkleRoot?: Uint8Array;
//   private _dateCreated: number;

//   private _viewAccess: AccessMap
//   private _editAccess: AccessMap

//   get file(): File {
//     return this._file;
//   }

//   protected constructor(file: File) {
//     this._file = file
//     this._dateCreated = Date.now()
//     this._viewAccess = {}
//     this._editAccess = {}
//   }

//   public static async New(file: File, opts: IFileUploadOptions) {
//     if (opts.encryption) {
//       opts.encryption.aes = opts.encryption.aes ?? await generateAesKey();
//       file = await encryptFile(file, opts.encryption)
//     }

//     const merkleRoot = (await buildFileMerkleTree(file)).getRoot();

//     const af = new AtlasFile(file)
//     af._merkleRoot = merkleRoot;

//     return af
//   }

//   // public static NewAsync(file: File, opts: FileUploadOptions) {
//   //   if (opts.encryption) {
//   //     opts.encryption.aes = opts.encryption.aes ?? await generateAesKey();
//   //     file = await encryptFile(file, opts.encryption)
//   //   }

//   //   const merkleRoot = buildFileMerkleTree(file).getRoot();

//   //   const af = new AtlasFile(file)
//   //   af._merkleRoot = merkleRoot;

//   //   return af
//   // }


    
//   protected async processFile() {
    
//   }

//   public getMerkleRoot(): Uint8Array | undefined {
//     return this._merkleRoot
//   }
  
//   public getFileInfo(): IAtlasFileInfo {
//     return {
//       name: this._file.name,
//       size: this._file.size,
//       type: this._file.type,
//       lastModified: this._file.lastModified,

//       merkleRoot: this._merkleRoot || new Uint8Array(),
//       dateUpdated: this._dateCreated,
//       dateCreated: this._dateCreated
//     }
//   }
  
//   public listViewers() {
//     return this._viewAccess
//   }

//   public listEditors() {
//     return this._editAccess
//   }

//   public addViewKey(address: string, aes: string) {
//     this._viewAccess[address] = aes
//   }

//   public getViewKey(address: string) {
//     return this._viewAccess[address]
//   }

//   public removeViewKey(address: string) {
//     delete this._viewAccess[address]
//   }

//   public addEditKey(address: string, aes: string) {
//     this._editAccess[address] = aes
//   }

//   public getEditKey(address: string) {
//     return this._editAccess[address]
//   }

//   public removeEditKey(address: string) {
//     delete this._editAccess[address]
//   }
// }

async function encryptFile(file: File, opts: IEncryptionOptions): Promise<File> {
  if (!opts.aes) throw new Error("AES key & iv are required in the encryption options!")

  const encryptedBytes: Blob[] = []
  for (let i = 0; i < file.size; i += opts.chunkSize ?? DEFAULT_ENCYRPTION_CHUNK_SIZE) {
    const blobChunk = file.slice(i, i + (opts.chunkSize ?? DEFAULT_ENCYRPTION_CHUNK_SIZE))
    encryptedBytes.push(
      new Blob([(blobChunk.size + 16).toString().padStart(8, '0')]),
      await aesBlobCrypt(blobChunk, opts.aes, 'encrypt'),
    )
  }

  return new File(encryptedBytes, file.name, { type: file.type, lastModified: file.lastModified })
}
