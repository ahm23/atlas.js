import { WalletConnection, WalletType } from "@/wallets";
// import { IStorageHandler } from "./IStorageHandler";
import { StorageHandler } from "@/storage";


export interface IAtlasClient {

  initialize(): Promise<void>

  connectWallet(type: WalletType, options?: any): Promise<WalletConnection>
  disconnectWallet(): Promise<void>

  createStorageHandler(): StorageHandler
}