import { WalletConnection, WalletType } from "@/wallets";
// import { IStorageHandler } from "./IStorageHandler";
import { StorageHandler } from "@/storage";
import { QueryHelper } from "@/query-helper";


export interface IAtlasClient {
  get query(): QueryHelper
  get isInitialized(): boolean
  get isConnected(): boolean

  initialize(): Promise<void>
  connectWallet(type: WalletType, options?: any): Promise<WalletConnection>
  disconnectWallet(): Promise<void>

  createStorageHandler(): StorageHandler

  getWalletType(): WalletType | null
  getCurrentAddress(): string | null
  isWalletConnected(): boolean

  getChainId(): string
}