import { WalletConnection, WalletType } from "@/wallets";
import { IStorageHandler } from "./IStorageHandler";


export interface IAtlasClient {

  initialize(): Promise<void>

  connectWallet(type: WalletType, options?: any): Promise<WalletConnection>
  disconnectWallet(): Promise<void>

  createStorageHandler(): IStorageHandler
}