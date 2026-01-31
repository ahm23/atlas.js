export interface IAtlasFileInfo {
  fid: string
  owner: string
  name: string
  size: number
  type: string
  lastModified: number

  merkleRoot: Uint8Array
  dateUpdated: number
  dateCreated: number
}