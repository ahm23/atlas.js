import { BaseWallet } from '../base-wallet';
import { 
  WalletConnection, 
  SigningResult, 
  WalletType 
} from '../types';
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { OfflineSigner } from '@cosmjs/proto-signing';
import { atlasDevnetChainConfig } from '@/utils/defaults';

declare global {
  interface Window {
    keplr: any;
    getOfflineSigner: any;
  }
}

export class KeplrWallet extends BaseWallet {
  private keplr: any;

  constructor(config: any) {
    super(config);
    this.keplr = window.keplr;
  }

  async connect(): Promise<WalletConnection> {
    if (!this.keplr) {
      throw new Error('Keplr wallet not installed');
    }

    try {
      // Enable Keplr for the chain
      await this.keplr.experimentalSuggestChain(atlasDevnetChainConfig);
      await this.keplr.enable(this.chainId);
      
      // Get offline signer from Keplr
      const offlineSigner: OfflineSigner = this.keplr.getOfflineSigner(this.chainId);
      
      // Get accounts
      const accounts = await offlineSigner.getAccounts();
      
      if (accounts.length === 0) {
        throw new Error('No accounts found in Keplr wallet');
      }

      // Initialize clients with the offline signer
      await this.initClients(offlineSigner, accounts[0].address);

      if (!this.walletConnection) {
        throw new Error('Failed to create wallet connection');
      }

      return this.walletConnection;
    } catch (error: any) {
      throw new Error(`Keplr connection failed: ${error.message}`);
    }
  }

  async disconnect(): Promise<void> {
    // Clean up resources
    this.signingClient = null;
    this.queryClient = null;
    this.offlineSigner = null;
    this.walletConnection = null;
  }

  async signArbitrary(data: string | Uint8Array): Promise<SigningResult> {
    if (!this.walletConnection) {
      throw new Error('Wallet not connected');
    }

    try {
      const signature = await this.keplr.signArbitrary(
        this.chainId,
        this.walletConnection.address,
        data
      );

      return {
        signature: Uint8Array.from(atob(signature.signature), c => c.charCodeAt(0)),
        txHash: ''
      };
    } catch (error: any) {
      throw new Error(`Signing failed: ${error.message}`);
    }
  }

  getWalletType(): WalletType {
    return WalletType.KEPLR;
  }

  static isAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.keplr;
  }
}