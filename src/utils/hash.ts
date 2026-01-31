import { bytesToHex, stringToUint8ArrayBuffer } from "./converters"
import { blake3 } from '@noble/hashes/blake3.js'

export async function buildFid(merkle: Uint8Array, creator: string, nonce: number): Promise<string> {
  // Combine all data
  const creatorBytes = new TextEncoder().encode(creator);
  
  // Create array to hold nonce as 4 bytes (int32, little-endian)
  const nonceBytes = new Uint8Array(4);
  const dataView = new DataView(nonceBytes.buffer);
  dataView.setInt32(0, nonce, true); // true for little-endian  (used in golang)
  
  // Combine all bytes
  const combined = new Uint8Array(merkle.length + creatorBytes.length + nonceBytes.length);
  combined.set(merkle, 0);
  combined.set(creatorBytes, merkle.length);
  combined.set(nonceBytes, merkle.length + creatorBytes.length);
  
  // Compute SHA-256
  const hash = await crypto.subtle.digest('SHA-256', combined);
  return bytesToHex(new Uint8Array(hash))
}

export async function hashAndHex(input: string): Promise<string> {
  const algo = 'SHA-256'
  const raw = await crypto.subtle.digest(algo, stringToUint8ArrayBuffer(input))
  return bytesToHex(new Uint8Array(raw))
}

export const h_blake3 = (bytes: Uint8Array) => blake3(bytes)
