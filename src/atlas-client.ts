import { WalletManager, WalletType, WalletConnection } from '@/wallets';
import EventEmitter from 'events';
import { StorageHandler } from './storage/storage-handler';
import { atlas } from '@atlas/atlas.js-protos';
import { QueryClient } from './wallets/types'
import { IStorageHandler } from './interfaces';
import { IAtlasClient } from './interfaces/classes/IAtlasClient';
import { IndexedTx } from '@cosmjs/stargate';
import { QueryHelper } from './query-helper';

export interface AtlasConfig {
  chainId: string;
  rpcEndpoint: string;
  restEndpoint?: string;
  gasPrice?: string;
  gasAdjustment?: number;
}

export enum ClientEvent {
  INITIALIZED = 'initialized',
}

export class AtlasClient extends EventEmitter implements IAtlasClient {
  private _config: AtlasConfig;
  private _walletManager: WalletManager;
  private _isInitialized: boolean = false;

  private _queryHelper: QueryHelper
  public queryClient: QueryClient
  
  declare on: (event: ClientEvent | string, listener: (...args: any[]) => void) => this;
  declare emit: (event: ClientEvent | string, ...args: any[]) => boolean;

  constructor(config: AtlasConfig) {
    super();
    
    // Validate required config
    if (!config.chainId) {
      throw new Error('chainId is required in config');
    }
    if (!config.rpcEndpoint) {
      throw new Error('rpcEndpoint is required in config');
    }

    this._config = config;
    
    // Initialize wallet manager with minimal config
    this._walletManager = new WalletManager({
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

  public get query(): QueryHelper
  {
    return this._queryHelper
  }

  public get isConnected(): boolean
  {
      return this._walletManager.isConnected();
  }
  public get isInitialized(): boolean
  {
      return this._isInitialized;
  }

  /**
   * Initialize the client (just sets up event listeners for now)
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    try {
      // For now, just mark as initialized
      this._isInitialized = true;

      this.queryClient = await atlas.ClientFactory.createRPCQueryClient({rpcEndpoint: this._config.rpcEndpoint})
      this._queryHelper = new QueryHelper(this.queryClient)

      this.emit(ClientEvent.INITIALIZED, {
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
      const connection = await this._walletManager.connect(type, options);
      
      // Ensure client is initialized
      if (!this._isInitialized) {
        await this.initialize();
      }
      
      return connection;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async disconnectWallet(): Promise<void> {
    try {
      await this._walletManager.disconnect();
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
      const result = await this._walletManager.signArbitrary(message);
      
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
  ): Promise<IndexedTx> {
    
    if (!this.isWalletConnected()) {
      throw new Error('Wallet not connected. Connect a wallet first.');
    }

    try {
      console.log("Messages:", messages)
      const txHash = await this._walletManager.signAndBroadcast(messages, { memo });
      const result = await this.waitForTransaction(txHash)
      return result
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  private async waitForTransaction(
    txHash: string, 
    timeout: number = 12000,
    pollInterval: number = 2000
  ): Promise<IndexedTx> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        // Query transaction using the hash
        console.log("TX HASH:", txHash)
        const txResponse = await this._walletManager.getQueryClient().getTx(txHash);
        
        // Check if transaction has been included in a block
        if (txResponse) {
          // Check transaction status (code 0 means success)
          if (txResponse.code === 0) {
            console.log(`Transaction ${txHash} succeeded`);
            return txResponse;
          } else {
            // Transaction failed with an error code
            throw new Error(
              `Transaction ${txHash} failed with code ${txResponse.code}: ${txResponse.rawLog}`
            );
          }
        }
      } catch (error) {
        // If error is not "not found", re-throw it
        if (!error.message?.includes('not found') && 
            !error.message?.includes('404') &&
            !error.message?.includes('does not exist')) {
          throw error;
        }
        // Transaction not found yet, continue polling
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Transaction ${txHash} timeout after ${timeout}ms`);
  }

  /**
   * Utility Methods
   */
  getCurrentAddress(): string {
    const connection = this._walletManager.getCurrentConnection();
    return connection?.address || "";
  }

  isWalletConnected(): boolean {
    return this._walletManager.isConnected();
  }

  getWalletType(): WalletType | null {
    const connection = this._walletManager.getCurrentConnection();
    return connection?.walletType || null;
  }

  getChainId(): string {
    return this._config.chainId;
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
    this._walletManager.on('connected', (connection) => {
      this.emit('walletConnected', connection.address);
    });

    this._walletManager.on('disconnected', () => {
      this.emit('walletDisconnected');
    });

    this._walletManager.on('clientsInitialized', (clients) => {
      this.emit('clientsInitialized', clients);
    });

    this._walletManager.on('clientsDestroyed', () => {
      this.emit('clientsDestroyed');
    });

    this._walletManager.on('error', (error) => {
      this.emit('walletError', error);
    });
  }

  /**
   * Cleanup
   */
  async dispose(): Promise<void> {
    try {
      await this.disconnectWallet();
      this._isInitialized = false;
      this.removeAllListeners();
      this.emit('destroyed');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
}