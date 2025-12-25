import { 
  WalletConfig, 
  WalletConnection, 
  WalletType, 
  SigningResult, 
  BroadcastResult, 
  TxOptions 
} from './types';
import { SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import { OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';

export abstract class BaseWallet {
  protected chainId: string;
  protected rpcEndpoint: string;
  protected config: WalletConfig;
  protected signingClient: SigningStargateClient | null = null;
  protected queryClient: StargateClient | null = null;
  protected offlineSigner: OfflineSigner | null = null;
  protected walletConnection: WalletConnection | null = null;

  constructor(config: WalletConfig) {
    this.chainId = config.chainId;
    this.rpcEndpoint = config.rpcEndpoint || 'http://localhost:26657';
    this.config = config;
  }

  abstract connect(): Promise<WalletConnection>;
  abstract disconnect(): Promise<void>;
  abstract signArbitrary(data: string | Uint8Array): Promise<SigningResult>;
  
  // Concrete methods that use persistent client
  async signTransaction(txBody: any, options?: TxOptions): Promise<SigningResult> {
    if (!this.walletConnection) {
      throw new Error('Wallet not connected');
    }

    if (!this.signingClient) {
      throw new Error('Signing client not initialized');
    }

    try {
      const fee = options?.fee || {
        amount: [{ denom: 'uatl', amount: '5000' }],
        gas: options?.gas || '200000'
      };

      const signedTx = await this.signingClient.sign(
        this.walletConnection.address,
        txBody.msgs,
        fee,
        options?.memo || ''
      );

      return {
        signedTx,
        txHash: '', // will be set after broadcast
        signature: new Uint8Array()
      };
    } catch (error: any) {
      throw new Error(`Transaction signing failed: ${error.message}`);
    }
  }

  async broadcastTransaction(signedTx: Uint8Array): Promise<BroadcastResult> {
    if (!this.signingClient) {
      throw new Error('Signing client not initialized');
    }

    try {
      const result = await this.signingClient.broadcastTx(signedTx);
      
      return {
        transactionHash: result.transactionHash,
        height: result.height,
        rawLog: result.rawLog || ''
      };
    } catch (error: any) {
      throw new Error(`Broadcast failed: ${error.message}`);
    }
  }

  async getAccount(): Promise<any> {
    if (!this.walletConnection) {
      throw new Error('Wallet not connected');
    }

    if (!this.queryClient) {
      throw new Error('Query client not initialized');
    }

    return await this.queryClient.getAccount(this.walletConnection.address);
  }

  async getBalance(address?: string): Promise<any> {
    if (!this.queryClient) {
      throw new Error('Query client not initialized');
    }

    const addr = address || this.walletConnection?.address;
    if (!addr) {
      throw new Error('No address provided');
    }

    return await this.queryClient.getAllBalances(addr);
  }

  async simulateTransaction(
    messages: any[],
    memo?: string,
    signer?: string
  ): Promise<number> {
    if (!this.signingClient) {
      throw new Error('Signing client not initialized');
    }

    const signerAddress = signer || this.walletConnection?.address;
    if (!signerAddress) {
      throw new Error('No signer address available');
    }

    return await this.signingClient.simulate(signerAddress, messages, memo);
  }

  protected async initClients(
    offlineSigner: OfflineSigner,
    address: string
  ): Promise<void> {
    try {
      // Create query client (read-only)
      this.queryClient = await StargateClient.connect(this.rpcEndpoint);
      
      // Create signing client
      const gasPrice = this.config.gasPrice 
        ? GasPrice.fromString(this.config.gasPrice)
        : GasPrice.fromString('0.025udepin');

      this.signingClient = await SigningStargateClient.connectWithSigner(
        this.rpcEndpoint,
        offlineSigner,
        {
          gasPrice,
        // gasAdjustment: this.config.gasAdjustment || 1.3,
        // why tf did they remove this?? ^^
        //
        // [TODO]: add registry for custom messages
        }
      );
      
      this.offlineSigner = offlineSigner;
      
      // Store wallet connection
      this.walletConnection = {
        address,
        signer: offlineSigner,
        walletType: this.getWalletType(),
        chainId: this.chainId,
        offlineSigner
      };
      
    } catch (error: any) {
      throw new Error(`Failed to initialize clients: ${error.message}`);
    }
  }

  abstract getWalletType(): WalletType;
  
  isConnected(): boolean {
    return !!this.walletConnection && !!this.signingClient;
  }

  getSigningClient(): SigningStargateClient | null {
    return this.signingClient;
  }

  getQueryClient(): StargateClient | null {
    return this.queryClient;
  }

  async refreshClients(): Promise<void> {
    if (!this.offlineSigner || !this.walletConnection) {
      throw new Error('Cannot refresh clients without a connection');
    }
    
    // Reinitialize clients (useful for reconnecting)
    await this.initClients(this.offlineSigner, this.walletConnection.address);
  }
}