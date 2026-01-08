import { IAesBundle } from "@/interfaces/encryption";
import { IFileMeta } from "@/interfaces/metadata";

export interface FileUploadOptions {
  encryption?: EncryptionOptions
  metadata?: Record<string, any>;
}

export interface EncryptionOptions {
  chunkSize: number;
  aes?: IAesBundle;
}

export interface QueuedFile {
  file: File,
  merkleRoot: Uint8Array, 
  aes?: IAesBundle;
  replicas?: number;
  timestamp: number;
}

export interface UploadOptions {
  storageNodes?: string[];
  replicationFactor?: number;
  pin?: boolean;
  customMetadata?: Record<string, any>;
}

export interface UploadResult {
  fileId: string;
  transactionHash: string;
  storageNodes: string[];
  timestamp: number;
}