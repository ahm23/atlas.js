// Export AtlasClient and related types
export { AtlasClient } from './atlas-client';
export type { AtlasConfig } from './atlas-client';

// Export wallet-related functionality
export { WalletManager } from './wallets';
export { WalletType } from './wallets';

// Re-export wallet types for convenience
export type { 
  WalletConnection, 
  WalletConfig,
  SigningResult,
  BroadcastResult,
  WalletInfo,
  TxOptions
} from './wallets/types';


export type {
  IAtlasClient,
  IStorageHandler,
  
  IAtlasFileInfo
} from './interfaces'


export * from './storage'