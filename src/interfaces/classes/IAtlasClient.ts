import { WalletConnection, WalletType } from "@/wallets";
// import { IStorageHandler } from "./IStorageHandler";
import { StorageHandler } from "@/storage";
import { QueryHelper } from "@/query-helper";
import { ClientEvent } from "@/atlas-client";


export interface IAtlasClient {
  on: (event: ClientEvent | string, listener: (...args: any[]) => void) => this;
  emit: (event: ClientEvent | string, ...args: any[]) => boolean;

  get query(): QueryHelper
  get isInitialized(): boolean
  get isConnected(): boolean

  initialize(): Promise<void>
  connectWallet(type: WalletType, options?: any): Promise<WalletConnection>
  disconnectWallet(): Promise<void>

  createStorageHandler(): StorageHandler

  getWalletType(): WalletType | null
  getCurrentAddress(): string
  isWalletConnected(): boolean

  getChainId(): string
}