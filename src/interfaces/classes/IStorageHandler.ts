import { IFileUploadOptions, QueuedFile, IFileMetadata, UploadResult } from "@/storage/types";


export interface IStorageHandler {

  // queueFile(file: File, options: FileUploadOptions): Promise<QueuedFile>
  
  // upload queued files
  // upload(): Promise<void>
  get subscriptionId(): string
  get subscriptionStatus(): string
  get storageUsed(): number
  get storageTotal(): number
}