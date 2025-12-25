import { IAesBundle } from "@/interfaces/encryption"
import { keyAlgo } from "./defaults"

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