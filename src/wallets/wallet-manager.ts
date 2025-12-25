import { 
  WalletType, 
  WalletConnection, 
  WalletConfig, 
  WalletInfo,
  SigningResult,
  BroadcastResult,
  TxOptions
} from './types';
import { BaseWallet } from './base-wallet';
import { KeplrWallet } from './adapters/keplr-adapter';
// import { LeapWallet } from './adapters/leap-adapter';
// import { MnemonicWallet } from './adapters/mnemonic-adapter';
import { SigningStargateClient, StargateClient } from '@cosmjs/stargate';

export class WalletManager {
  private wallet: BaseWallet | null = null;
  private config: WalletConfig;
  private listeners: Map<string, Function[]> = new Map();

  constructor(config: WalletConfig) {
    this.config = config;
  }

  async connect(type: WalletType, options?: any): Promise<WalletConnection> {
    // Disconnect existing wallet
    await this.disconnect();

    // Create wallet based on type
    switch (type) {
      case WalletType.KEPLR:
        if (!KeplrWallet.isAvailable()) {
          throw new Error('Keplr wallet is not available');
        }
        this.wallet = new KeplrWallet(this.config);
        break;
      
    //   case WalletType.LEAP:
    //     if (!LeapWallet.isAvailable()) {
    //       throw new Error('Leap wallet is not available');
    //     }
    //     this.wallet = new LeapWallet(this.config);
    //     break;
      
    //   case WalletType.MNEMONIC:
    //     if (!options?.mnemonic) {
    //       throw new Error('Mnemonic is required for mnemonic wallet');
    //     }
    //     this.wallet = new MnemonicWallet({
    //       ...this.config,
    //       mnemonic: options.mnemonic,
    //       hdPath: options.hdPath,
    //       prefix: options.prefix
    //     });
    //     break;
      
      default:
        throw new Error(`Unsupported wallet type: ${type}`);
    }

    // connect wallet
    const connection = await this.wallet.connect();
    
    // emit connection event
    this.emit('connected', connection);
    this.emit('clientsInitialized', {
      signingClient: this.getSigningClient(),
      queryClient: this.getQueryClient()
    });
    
    return connection;
  }

  async disconnect(): Promise<void> {
    if (this.wallet) {
      await this.wallet.disconnect();
      this.wallet = null;
      
      // Emit disconnection event
      this.emit('disconnected', null);
      this.emit('clientsDestroyed', null);
    }
  }

  // direct access to clients
  getSigningClient(): SigningStargateClient | null {
    return this.wallet?.getSigningClient() || null;
  }

  getQueryClient(): StargateClient | null {
    return this.wallet?.getQueryClient() || null;
  }

  async signArbitrary(data: string | Uint8Array): Promise<SigningResult> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    return await this.wallet.signArbitrary(data);
  }

  async signAndBroadcast(
    messages: any[],
    memo?: string,
    options?: TxOptions
  ): Promise<BroadcastResult> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }

    const txBody = { msgs: messages };
    const signed = await this.wallet.signTransaction(txBody, options);
    return await this.wallet.broadcastTransaction(signed.signedTx!.bodyBytes);
  }

  async signTransaction(txBody: any, options?: TxOptions): Promise<SigningResult> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    return await this.wallet.signTransaction(txBody, options);
  }

  async broadcastTransaction(signedTx: Uint8Array): Promise<BroadcastResult> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    return await this.wallet.broadcastTransaction(signedTx);
  }

  async getAccount(): Promise<any> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    return await this.wallet.getAccount();
  }

  async getBalance(address?: string): Promise<any> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    return await this.wallet.getBalance(address);
  }

  async simulateTransaction(
    messages: any[],
    memo?: string,
    signer?: string
  ): Promise<number> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    return await this.wallet.simulateTransaction(messages, memo, signer);
  }

  async refreshConnection(): Promise<void> {
    if (!this.wallet) {
      throw new Error('No wallet connected');
    }
    
    if (this.wallet.refreshClients) {
      await this.wallet.refreshClients();
      this.emit('clientsRefreshed', {
        signingClient: this.getSigningClient(),
        queryClient: this.getQueryClient()
      });
    }
  }

  getCurrentWallet(): BaseWallet | null {
    return this.wallet;
  }

  getCurrentConnection(): WalletConnection | null {
    return this.wallet?.isConnected() ? this.wallet.getWalletConnection() : null;
  }

  isConnected(): boolean {
    return this.wallet ? this.wallet.isConnected() : false;
  }

  getAvailableWallets(): WalletInfo[] {
    const wallets: WalletInfo[] = [];

    // check Keplr
    wallets.push({
      name: 'Keplr',
      logo: 'keplr-logo',
      isInstalled: typeof window !== 'undefined' && !!window.keplr,
      isAvailable: true
    });

    // // check Leap
    // wallets.push({
    //   name: 'Leap',
    //   logo: 'leap-logo',
    //   isInstalled: typeof window !== 'undefined' && !!window.leap,
    //   isAvailable: true
    // });

    return wallets;
  }

  // event handling
  on(event: string, callback: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback: Function): void {
    if (!this.listeners.has(event)) return;
    
    const callbacks = this.listeners.get(event)!;
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  }

  private emit(event: string, data: any): void {
    if (!this.listeners.has(event)) return;
    
    this.listeners.get(event)!.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error);
      }
    });
  }
}

// Add getWalletConnection method to BaseWallet
declare module './base-wallet' {
  interface BaseWallet {
    getWalletConnection(): WalletConnection | null;
  }
}
BaseWallet.prototype.getWalletConnection = function() {
  return this.walletConnection;
};