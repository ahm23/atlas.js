import { IAesBundle } from "@/interfaces/encryption";
import { IFileMeta } from "@/interfaces/metadata";

export interface FileOptions {
  encrypt?: boolean;
  chunkSize?: number;
  metadata?: Record<string, any>;
}

export interface QueuedFile {
  id: string,
  file: File,
  fileMeta: IFileMeta
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