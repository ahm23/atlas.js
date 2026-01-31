import { IAtlasFileInfo } from "./types/IAtlasFileInfo";
import { IDirectoryInfo } from "./types/IDirectoryInfo";


export interface IDirectory {  
  path: string
  files: IAtlasFileInfo[]
  subdirs: IDirectoryInfo[]
  objects: string[]

  metadata: any
}