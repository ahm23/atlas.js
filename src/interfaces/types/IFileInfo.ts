export interface IAtlasFileInfo {
  name: string
  size: number
  type: string
  lastModified: number

  merkleRoot: Uint8Array
  dateUpdated: number
  dateCreated: number
}