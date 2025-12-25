import { IChainConfig } from "@/wallets/types";

export const defaultEncryptionChunkSize: number = 32 * Math.pow(1024, 2)
export const keyAlgo: AesKeyGenParams = {
  name: 'AES-GCM',
  length: 256,
}

export const atlasDevnetChainConfig: IChainConfig = {
  chainId: 'atlas-1',
  chainName: 'Atlas Protocol',
  rpc: 'localhost:26657',
  rest: 'localhost:1317',
  bip44: {
    coinType: 118,
  },
  stakeCurrency: {
    coinDenom: 'ATL',
    coinMinimalDenom: 'uatl',
    coinDecimals: 6,
  },
  bech32Config: {
    bech32PrefixAccAddr: 'atl',
    bech32PrefixAccPub: 'atlpub',
    bech32PrefixValAddr: 'atlvaloper',
    bech32PrefixValPub: 'atlvaloperpub',
    bech32PrefixConsAddr: 'atlvalcons',
    bech32PrefixConsPub: 'atlvalconspub',
  },
  currencies: [
    {
      coinDenom: 'ATL',
      coinMinimalDenom: 'uatl',
      coinDecimals: 6,
    },
  ],
  feeCurrencies: [
    {
      coinDenom: 'ATL',
      coinMinimalDenom: 'uatl',
      coinDecimals: 6,
      gasPriceStep: {
        low: 0.002,
        average: 0.002,
        high: 0.02,
      },
    },
  ],
  features: [],
}
