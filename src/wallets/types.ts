import { Query as BankQuery } from "@atlas/atlas.js-protos/dist/types/cosmos/bank/v1beta1/query.rpc.Query";
import { Query as FiletreeQuery } from "@atlas/atlas.js-protos/dist/types/nebulix/filetree/v1/query.rpc.Query";
import { Query as StorageQuery } from "@atlas/atlas.js-protos/dist/types/nebulix/storage/v1/query.rpc.Query";

import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

export interface WalletConfig {
  chainId: string;
  rpcEndpoint?: string;
  restEndpoint?: string;
  gasPrice?: string;
  gasAdjustment?: number;
}

export interface WalletConnection {
  address: string;
  signer: any;
  walletType: WalletType;
  chainId: string;
  offlineSigner?: any;
}

export interface SigningResult {
  signedTx?: TxRaw;
  txHash?: string;
  signature: Uint8Array;
}

export interface BroadcastResult {
  transactionHash: string;
  height: number;
  rawLog: string;
}

export enum WalletType {
  KEPLR = 'keplr',
  LEAP = 'leap',
  MNEMONIC = 'mnemonic',
  NONE = 'none'
}

export interface WalletInfo {
  name: string;
  logo: string;
  isInstalled: boolean;
  isAvailable: boolean;
}

export interface TxOptions {
  memo?: string;
  fee?: any;
  gas?: string;
}

export interface IChainConfig {
  chainId: string
  chainName: string
  rpc: string
  rest: string
  bip44: {
    coinType: number
  }
  stakeCurrency: {
    coinDenom: string
    coinMinimalDenom: string
    coinDecimals: number
  }
  bech32Config: {
    bech32PrefixAccAddr: string
    bech32PrefixAccPub: string
    bech32PrefixValAddr: string
    bech32PrefixValPub: string
    bech32PrefixConsAddr: string
    bech32PrefixConsPub: string
  }
  currencies: IChainCurrency[]
  feeCurrencies: IChainCurrency[]
  features: string[]
}

interface IChainCurrency {
  coinDenom: string
  coinMinimalDenom: string
  coinDecimals: number
  gasPriceStep?: {
    low: number
    average: number
    high: number
  }
}

export interface QueryClient {
  cosmos: {
    bank: {
      v1beta1: BankQuery
    }
  },
  nebulix: {
    filetree: {
      v1: FiletreeQuery,
    },
    storage: {
      v1: StorageQuery,
    }
  }
}