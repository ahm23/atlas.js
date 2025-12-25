import { WalletConfig } from '../wallets/types';

export interface AtlasNetworkConfig {
  chainId: string;
  rpcEndpoint: string;
  restEndpoint?: string;
  explorerUrl?: string;
  gasPrice?: string;
  gasAdjustment?: number;
}

export interface AtlasStorageConfig {
  storageProvider?: 'ipfs' | 'arweave' | 'custom';
  ipfsGateway?: string;
  ipfsApiEndpoint?: string;
  replicationFactor?: number;
  chunkSize?: number;
  encryptionEnabled?: boolean;
}

export interface AtlasUploadOptions {
  encrypt?: boolean;
  encryptionKey?: string;
  chunkSize?: number;
  replicationFactor?: number;
  metadata?: Record<string, any>;
  onProgress?: (progress: UploadProgress) => void;
  pin?: boolean;
  storageNodes?: string[];
}

export interface AtlasDownloadOptions {
  decrypt?: boolean;
  decryptionKey?: string;
  savePath?: string;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface AtlasConfig {
  network: AtlasNetworkConfig;
  storage?: AtlasStorageConfig;
  wallet?: Partial<WalletConfig>;
  autoConnect?: boolean;
  debug?: boolean;
}

export interface UploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
  percentage: number;
  stage: 'chunking' | 'uploading' | 'registering' | 'complete';
}

export interface DownloadProgress {
  bytesDownloaded: number;
  bytesTotal: number;
  percentage: number;
  stage: 'fetching' | 'downloading' | 'assembling' | 'complete';
}

export interface FileMetadata {
  id: string;
  name?: string;
  size: number;
  type?: string;
  hash: string;
  uploadedAt: number;
  owner: string;
  storageNodes: string[];
  isEncrypted: boolean;
  customMetadata?: Record<string, any>;
}

export interface UploadResult {
  fileId: string;
  cid?: string;
  storageNodes: string[];
  size: number;
  timestamp: number;
  transactionHash?: string;
  metadata: FileMetadata;
}

export interface DownloadResult {
  fileId: string;
  data: Buffer | Uint8Array;
  filePath?: string;
  metadata: FileMetadata;
}