import { IDirectoryNodeContents, IFileNodeContents } from "@/storage/types";

export type IAtlasFileInfo = IFileNodeContents
export type IAtlasDirectoryInfo = IDirectoryNodeContents

export interface IDirectory {  
  path: string
  files: IAtlasFileInfo[]
  subdirs: IAtlasDirectoryInfo[]
  objects: string[]

  metadata: any
}