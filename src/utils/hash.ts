import { bufferToHex, stringToUint8ArrayBuffer } from "./converters"



export async function hashAndHex (input: string): Promise<string> {
  const algo = 'SHA-256'
  const raw = await crypto.subtle.digest(algo, stringToUint8ArrayBuffer(input))
  return bufferToHex(new Uint8Array(raw))
}