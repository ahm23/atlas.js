// import { BaseWallet } from './base-wallet';
// import { 
//   WalletConnection, 
//   SigningResult, 
//   WalletType,
//   WalletConfig, 
// } from './types';
// import { DirectSecp256k1HdWallet, makeCosmoshubPath } from '@cosmjs/proto-signing';
// import { HdPath } from '@cosmjs/crypto';
// import { OfflineSigner } from '@cosmjs/proto-signing';

// export interface MnemonicConfig {
//   mnemonic: string;
//   hdPath?: HdPath;
//   prefix?: string;
// }

// export class MnemonicWallet extends BaseWallet {
//   private mnemonic: string;
//   private hdPath: HdPath;
//   private prefix: string;
//   private wallet: DirectSecp256k1HdWallet | null = null;

//   constructor(config: WalletConfig & MnemonicConfig) {
//     super(config);
//     this.mnemonic = config.mnemonic;
//     this.hdPath = config.hdPath || makeCosmoshubPath(0);
//     this.prefix = config.prefix || 'depin';
//   }

//   async connect(): Promise<WalletConnection> {
//     try {
//       // Create wallet from mnemonic
//       this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, {
//         hdPaths: [this.hdPath],
//         prefix: this.prefix
//       });

//       // Get accounts
//       const accounts = await this.wallet.getAccounts();
      
//       // Initialize clients with the wallet as offline signer
//       await this.initClients(this.wallet as OfflineSigner, accounts[0].address);

//       if (!this.walletConnection) {
//         throw new Error('Failed to create wallet connection');
//       }

//       return this.walletConnection;
//     } catch (error: any) {
//       throw new Error(`Mnemonic wallet creation failed: ${error.message}`);
//     }
//   }

//   async disconnect(): Promise<void> {
//     this.wallet = null;
//     this.signingClient = null;
//     this.queryClient = null;
//     this.offlineSigner = null;
//     this.walletConnection = null;
//   }

//   async signArbitrary(data: string | Uint8Array): Promise<SigningResult> {
//     if (!this.wallet || !this.walletConnection) {
//       throw new Error('Wallet not connected');
//     }

//     try {
//       const signature = await this.wallet.signArbitrary(
//         this.walletConnection.address,
//         data
//       );

//       return {
//         signature,
//         signedTx: new Uint8Array(),
//         txHash: ''
//       };
//     } catch (error) {
//       throw new Error(`Mnemonic signing failed: ${error.message}`);
//     }
//   }

//   getWalletType(): WalletType {
//     return WalletType.MNEMONIC;
//   }

//   // Helper method to generate new mnemonic
//   static async generateMnemonic(length: 12 | 24 = 24): Promise<string> {
//     const wallet = await DirectSecp256k1HdWallet.generate(length);
//     const mnemonic = wallet.mnemonic;
//     return mnemonic;
//   }

//   // Helper method to validate mnemonic
//   static validateMnemonic(mnemonic: string): boolean {
//     // Simple validation - you might want to use a proper validation library
//     const words = mnemonic.trim().split(/\s+/);
//     return words.length === 12 || words.length === 24;
//   }
// }