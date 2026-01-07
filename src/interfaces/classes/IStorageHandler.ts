import { FileOptions, QueuedFile, UploadOptions, UploadResult } from "@/storage/types";


export interface IStorageHandler {

  queueFile(file: File, options: FileOptions): Promise<QueuedFile>
  
  // upload queued files
  upload(): Promise<void>
}