import { WalletManager, WalletType, WalletConnection } from '@/wallets';
import EventEmitter from 'events';
import { StorageHandler } from './storage/storage-handler';
import { nebulix } from '@atlas/atlas.js-protos';
import { QueryClient } from './wallets/types'
import { IStorageHandler } from './interfaces';
import { IAtlasClient } from './interfaces/classes/IAtlasClient';

export interface AtlasConfig {
  chainId: string;
  rpcEndpoint: string;
  restEndpoint?: string;
  gasPrice?: string;
  gasAdjustment?: number;
}

export class AtlasClient extends EventEmitter implements IAtlasClient {
  private config: AtlasConfig;
  private walletManager: WalletManager;
  private isInitialized: boolean = false;

  public query: QueryClient

  constructor(config: AtlasConfig) {
    super();
    
    // Validate required config
    if (!config.chainId) {
      throw new Error('chainId is required in config');
    }
    if (!config.rpcEndpoint) {
      throw new Error('rpcEndpoint is required in config');
    }

    this.config = config;
    
    // Initialize wallet manager with minimal config
    this.walletManager = new WalletManager({
      chainId: config.chainId,
      rpcEndpoint: config.rpcEndpoint,
      restEndpoint: config.restEndpoint,
      gasPrice: config.gasPrice,
      gasAdjustment: config.gasAdjustment
    });

    // Forward wallet manager events
    this.setupEventForwarding();
    this.initialize();
  }

  /**
   * Initialize the client (just sets up event listeners for now)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // For now, just mark as initialized
      this.isInitialized = true;

      this.query = await nebulix.ClientFactory.createRPCQueryClient({rpcEndpoint: this.config.rpcEndpoint})

      this.emit('initialized', {
        client: this,
        timestamp: Date.now()
      });

      console.log('AtlasClient initialized');
    } catch (error: any) {
      this.emit('error', error);
      throw new Error(`Failed to initialize AtlasClient: ${error.message}`);
    }
  }

  /**
   * Wallet Connection Methods
   */
  async connectWallet(
    type: WalletType, 
    options?: any
  ): Promise<WalletConnection> {
    try {
      const connection = await this.walletManager.connect(type, options);
      
      // Ensure client is initialized
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      this.emit('walletConnected', connection);

      return connection;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async disconnectWallet(): Promise<void> {
    try {
      await this.walletManager.disconnect();
      this.emit('walletDisconnected');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Signing Methods
   */
  async signMessage(message: string | Uint8Array): Promise<{
    signature: Uint8Array;
    signedMessage: string | Uint8Array;
  }> {
    if (!this.isWalletConnected()) {
      throw new Error('Wallet not connected. Connect a wallet first.');
    }

    try {
      const result = await this.walletManager.signArbitrary(message);
      
      this.emit('messageSigned', {
        message,
        signature: result.signature
      });
      
      return {
        signature: result.signature,
        signedMessage: message
      };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async signAndBroadcast(
    messages: any[],
    memo?: string,
  ): Promise<string> {
    
    if (!this.isWalletConnected()) {
      throw new Error('Wallet not connected. Connect a wallet first.');
    }

    try {
      console.log("Messages:", messages)
      const result = await this.walletManager.signAndBroadcast(messages, memo, undefined);
      return result.transactionHash
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Utility Methods
   */
  getCurrentAddress(): string | null {
    const connection = this.walletManager.getCurrentConnection();
    return connection?.address || null;
  }

  isWalletConnected(): boolean {
    return this.walletManager.isConnected();
  }

  getWalletType(): WalletType | null {
    const connection = this.walletManager.getCurrentConnection();
    return connection?.walletType || null;
  }

  getChainId(): string {
    return this.config.chainId;
  }

  /**
   * Handler Factories
   */
  createStorageHandler(): StorageHandler {
    return new StorageHandler(this)
  }

  /**
   * Event Management
   */

  private setupEventForwarding(): void {
    // Forward wallet manager events
    this.walletManager.on('connected', (connection) => {
      this.emit('walletConnected', connection);
    });

    this.walletManager.on('disconnected', () => {
      this.emit('walletDisconnected');
    });

    this.walletManager.on('clientsInitialized', (clients) => {
      this.emit('clientsInitialized', clients);
    });

    this.walletManager.on('clientsDestroyed', () => {
      this.emit('clientsDestroyed');
    });

    this.walletManager.on('error', (error) => {
      this.emit('walletError', error);
    });
  }

  /**
   * Cleanup
   */
  async dispose(): Promise<void> {
    try {
      await this.disconnectWallet();
      this.isInitialized = false;
      this.removeAllListeners();
      this.emit('destroyed');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
}