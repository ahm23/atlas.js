import { IFileInfo } from "./types/IFileInfo";
import { IDirectoryInfo } from "./types/IDirectoryInfo";


export interface IDirectory {
  metadata: IDirectoryInfo
  
  files: IFileInfo[]
  subdirs: IDirectoryInfo[]
  objects: string[]
}