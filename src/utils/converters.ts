import { IFileMeta } from "@/interfaces/metadata"

export function stringToUint8ArrayBuffer(str: string): ArrayBuffer {
  const uintView = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    uintView[i] = str.charCodeAt(i)
  }
  return uintView.buffer
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function extractFileMetaData(input: File): IFileMeta {
  const { name, size, type, lastModified = Date.now() } = input
  return { lastModified, name, size, type }
}
