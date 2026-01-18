import { 
  WalletConfig, 
  WalletConnection, 
  WalletType, 
  SigningResult, 
  BroadcastResult, 
  TxOptions 
} from './types';
import { DeliverTxResponse, SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import { OfflineSigner as OfflineAminoSigner, Registry } from '@cosmjs/proto-signing';
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { GasPrice } from '@cosmjs/stargate';
import { nebulix, cosmos, GlobalDecoderRegistry } from '@atlas/atlas.js-protos'
import { toBase64, toHex } from "@cosmjs/encoding";

export abstract class BaseWallet {
  protected chainId: string;
  protected rpcEndpoint: string;
  protected config: WalletConfig;
  protected signingClient: SigningStargateClient | null = null;
  protected queryClient: StargateClient | null = null;
  protected offlineSigner: OfflineAminoSigner | null = null;
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
  async signAndBroadcastTransaction(txBody: any, options?: TxOptions): Promise<DeliverTxResponse> {
    if (!this.walletConnection) {
      throw new Error('Wallet not connected');
    }

    if (!this.signingClient) {
      throw new Error('Signing client not initialized');
    }

    try {
      const fee = options?.fee || {
        amount: [{ denom: 'uatl', amount: '250000' }],
        gas: options?.gas || '250000'
      };
      console.log("signed tx msgs:", txBody.msgs)
      const signedTx = await this.signingClient.signAndBroadcast(
        this.walletConnection.address,
        txBody.msgs,
        fee,
        options?.memo || ''
      );

      return signedTx;
    } catch (error: any) {
      throw new Error(`Transaction signing failed: ${error.message}`);
    }
  }

  // Concrete methods that use persistent client
  async signTransaction(txBody: any, options?: TxOptions): Promise<TxRaw> {
    if (!this.walletConnection) {
      throw new Error('Wallet not connected');
    }

    if (!this.signingClient) {
      throw new Error('Signing client not initialized');
    }

    try {
      const fee = options?.fee || {
        amount: [{ denom: 'uatl', amount: '0' }],
        gas: options?.gas || '0'
      };
      console.log("signed tx msgs:", txBody.msgs)
      const signedTx = await this.signingClient.sign(
        this.walletConnection.address,
        txBody.msgs,
        fee,
        options?.memo || ''
      );

      return signedTx;
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
    offlineSigner: OfflineAminoSigner,
    address: string
  ): Promise<void> {
    try {
      // Create query client (read-only)
      this.queryClient = await StargateClient.connect(this.rpcEndpoint);
      
      // Create signing client
      const gasPrice = this.config.gasPrice 
        ? GasPrice.fromString(this.config.gasPrice)
        : GasPrice.fromString('0.025udepin');

      // Create registry with the new, correctly-generated types
      const registry = new Registry();
      console.log("REGISTRY:", GlobalDecoderRegistry.registry)
      for (const [typeUrl, decoder] of Object.entries(GlobalDecoderRegistry.registry)) {
        registry.register(typeUrl, decoder as any);  // 'as any' to satisfy types (TelescopeGeneratedCodec extends GeneratedType)
      }
      // nebulix.storage.v1.load(registry)
      // nebulix.filetree.v1.load(registry)

      // this.signingClient = await nebu

      // Create client
      this.signingClient = await SigningStargateClient.connectWithSigner(
        this.rpcEndpoint,
        offlineSigner,
        { 
          registry,
          gasPrice: GasPrice.fromString("0.025uatl")
         }
      );

      // const originalBroadcastTx = this.signingClient.broadcastTx;
  
      // this.signingClient.broadcastTx = async function(txBytes) {
      //   console.log("TxBytes:", txBytes);
      //   console.log("Broadcasting transaction bytes:", {
      //     length: txBytes.length,
      //     hex: toHex(txBytes),
      //     base64: toBase64(txBytes)
      //   });
      //   return originalBroadcastTx.call(this, txBytes);
      // };

      // const originalEncode = cosmos.bank.v1beta1.MsgSend.encode;
      // let encodeCallCount = 0;
      // let encodeInput = null;
      
      // cosmos.bank.v1beta1.MsgSend.encode = function(message, writer) {
      //   encodeCallCount++;
      //   encodeInput = message;
      //   console.log(`Encode called #${encodeCallCount}:`, {
      //     constructor: message.constructor.name,
      //     // isTelescopeObject: message instanceof cosmos.bank.v1beta1.MsgSend,
      //     rawData: message
      //   });
      //   return originalEncode.call(this, message, writer);
      // };

      console.log(offlineSigner)
      console.log(this.signingClient)

      const sendAmount = { denom: "uatl", amount: "100000" };
      try {
        const resp = await this.signingClient.sendTokens(
          "atl1wwrfl6n5qfrhldpjngp7stshnd9tgcv0u2qzvu",
          "atl1wszdmd04uxggyz2hq8u4ss30f8dy59zz28mn2x",
          [sendAmount],
          "auto"
        )
      } catch (err: any) {
        console.error("err!", err)
      }


      this.offlineSigner = offlineSigner;
            await this.compareEncodings()
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

  async compareEncodings() {
    // Import browser-compatible encoding utilities
    
    
    // Method 1: Create message via Telescope
    const cmsg_raw = cosmos.bank.v1beta1.MsgSend.fromPartial({
      fromAddress: "atl1wwrfl6n5qfrhldpjngp7stshnd9tgcv0u2qzvu",
      toAddress: "atl1wwrfl6n5qfrhldpjngp7stshnd9tgcv0u2qzvu",
      amount: [{ denom: "uatl", amount: "1000" }]
    });

    // Encode with Telescope's encoder
    const telescopeBytes = cosmos.bank.v1beta1.MsgSend.encode(cmsg_raw).finish();
    console.log("Telescope encoding (hex):", toHex(telescopeBytes));

    // Method 2: Create equivalent message via CosmJS's registry
    // Get the encoder from your client's registry
    const registry = this.signingClient.registry;
    const cosmjsEncoder = registry.lookupType("/cosmos.bank.v1beta1.MsgSend");
    
    const cosmjsMsg = {
      fromAddress: "atl1wwrfl6n5qfrhldpjngp7stshnd9tgcv0u2qzvu",
      toAddress: "atl1wwrfl6n5qfrhldpjngp7stshnd9tgcv0u2qzvu",
      amount: [{ denom: "uatl", amount: "1000" }]
    };

    const cosmjsBytes = cosmjsEncoder.encode(cosmjsMsg).finish();
    console.log("CosmJS encoding (hex):", toHex(cosmjsBytes));

    // Compare byte by byte
    console.log("\nByte comparison:");
    const minLength = Math.min(telescopeBytes.length, cosmjsBytes.length);
    for (let i = 0; i < minLength; i++) {
      if (telescopeBytes[i] !== cosmjsBytes[i]) {
        console.log(`Byte ${i}: Telescope=0x${telescopeBytes[i].toString(16)}, CosmJS=0x${cosmjsBytes[i].toString(16)}`);
        
        // Decode field info from this byte
        const tTag = telescopeBytes[i];
        const tFieldNum = tTag >>> 3;
        const tWireType = tTag & 0x07;
        
        const cTag = cosmjsBytes[i];
        const cFieldNum = cTag >>> 3;
        const cWireType = cTag & 0x07;
        
        console.log(`  Telescope: field ${tFieldNum}, wire ${tWireType}`);
        console.log(`  CosmJS: field ${cFieldNum}, wire ${cWireType}`);
        
        if (tWireType === 7) {
          console.log("  🚨 Telescope is using wire type 7 (deprecated group)!");
        }
      }
    }
    
    // Additional check: decode Telescope bytes with CosmJS decoder
    console.log("\n=== Can CosmJS decode Telescope's bytes? ===");
    try {
      const decodedByCosmJS = cosmjsEncoder.decode(telescopeBytes);
      console.log("✅ CosmJS can decode Telescope's bytes");
      console.log("Decoded:", decodedByCosmJS);
    } catch (e) {
      console.log("❌ CosmJS CANNOT decode Telescope's bytes:", e.message);
    }
    
    // Check if the difference is ONLY in field ordering
    const telescopeSorted = new Uint8Array([...telescopeBytes].sort((a, b) => a - b));
    const cosmjsSorted = new Uint8Array([...cosmjsBytes].sort((a, b) => a - b));
    const sameBytes = telescopeSorted.every((val, idx) => val === cosmjsSorted[idx]);
    console.log("\nSame bytes (ignoring order):", sameBytes);
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