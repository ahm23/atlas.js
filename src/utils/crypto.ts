import { decrypt, encrypt, PrivateKey } from 'eciesjs'

import { IAesBundle } from "@/interfaces/encryption"
import { keyAlgo } from "./defaults"
import { hexToBytes } from './atlas-merkletree'

export async function aesBlobCrypt (
  data: Blob,
  aes: IAesBundle,
  mode: 'encrypt' | 'decrypt',
): Promise<Blob> {
  try {
    const workingData = await data.arrayBuffer()
    const result = await aesCrypt(workingData, aes, mode)
    return new Blob([result])
  } catch (err) {
    throw err
  }
}

export async function aesCrypt (
  data: ArrayBuffer,
  aes: IAesBundle,
  mode: 'encrypt' | 'decrypt',
): Promise<ArrayBuffer> {
  try {
    const algo = {
      name: 'AES-GCM',
      iv: aes.iv,
    }
    if (data.byteLength < 1) {
      return new ArrayBuffer(0)
    } else if (mode?.toLowerCase() === 'encrypt') {
      try {
        return await crypto.subtle.encrypt(algo, aes.key, data)
      } catch (err) {
        console.warn('encrypt')
        throw err
      }
    } else {
      try {
        return await crypto.subtle.decrypt(algo, aes.key, data)
      } catch (err) {
        console.warn('decrypt')
        throw err
      }
    }
  } catch (err) {
    throw err
  }
}

export async function generateAesKey(): Promise<IAesBundle> {
  return { key: await genKey(), iv: genIv() }
}

function genKey (): Promise<CryptoKey> {
  try {
    return crypto.subtle.generateKey(keyAlgo, true, ['encrypt', 'decrypt'])
  } catch (err) {
    throw err
  }
}

function genIv (): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

export async function exportAesBundle(eciesKey: string, aes: IAesBundle): Promise<string> {
  const key = new Uint8Array(await crypto.subtle.exportKey('raw', aes.key))
  const keyString = eciesEncrypt(eciesKey, key)
  const ivString = eciesEncrypt(eciesKey, aes.iv)
  return `${ivString}|${keyString}`
}

export function eciesEncrypt(key: string, content: Uint8Array): string {
  return encrypt(key, content).toString('hex')
}

export function eciesDecrypt(key: PrivateKey, content: string): Uint8Array {
  return new Uint8Array(decrypt(key.toHex(), hexToBytes(content)))
}