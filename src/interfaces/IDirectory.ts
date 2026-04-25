import { IDirectoryNodeContents, ITreeNodeContents } from "@/storage/types";

export type IAtlasFileInfo = ITreeNodeContents
export type IAtlasDirectoryInfo = IDirectoryNodeContents

export interface IDirectory {  
  path: string
  files: IAtlasFileInfo[]
  subdirs: IAtlasDirectoryInfo[]
  objects: string[]

  metadata: any
}