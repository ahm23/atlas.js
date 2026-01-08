import { bufferToHex, stringToUint8ArrayBuffer } from "./converters"
import { blake3 } from '@noble/hashes/blake3.js'


export async function hashAndHex(input: string): Promise<string> {
  const algo = 'SHA-256'
  const raw = await crypto.subtle.digest(algo, stringToUint8ArrayBuffer(input))
  return bufferToHex(new Uint8Array(raw))
}

export const h_blake3 = (buf: ArrayBuffer) => blake3(new Uint8Array(buf)).buffer as ArrayBuffer
