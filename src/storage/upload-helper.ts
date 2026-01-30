import axios, { AxiosProgressEvent, AxiosResponse, AxiosError } from 'axios';

export interface UploadResult {
  success: boolean;
  message?: string;
  data?: any;
}

export class UploadHelper {
  private static readonly MAX_ATTEMPTS = 2;
  private static readonly RETRY_DELAY = 3000;

  /**
   * Upload with Axios (has built-in progress tracking)
   */
  public static async upload(
    hostname: string, 
    fileId: string, 
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<UploadResult> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`Upload attempt ${attempt} for file: ${file.name}`);
        
        const result = await this.executeUpload(
          hostname, 
          fileId, 
          file, 
          onProgress
        );
        
        console.log(`Upload successful on attempt ${attempt}`);
        return result;
        
      } catch (error) {
        lastError = error as Error;
        console.error(`Upload attempt ${attempt} failed:`, error);
        
        if (attempt === this.MAX_ATTEMPTS) break;
        
        console.log(`Waiting ${this.RETRY_DELAY}ms before retry...`);
        await this.delay(this.RETRY_DELAY);
        
        if (onProgress) onProgress(0);
      }
    }
    
    return {
      success: false,
      message: `Upload failed. Last error: ${lastError?.message}`
    };
  }

  /**
   * Execute upload using Axios (modern, clean API with progress)
   */
  private static async executeUpload(
    hostname: string, 
    fileId: string, 
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<UploadResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('fileId', fileId);
    formData.append('fileName', file.name);
    formData.append('fileSize', file.size.toString());
    formData.append('fileType', file.type);

    try {
      const response = await axios.post(`${hostname}/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        // Axios has built-in upload progress!
        onUploadProgress: (progressEvent: AxiosProgressEvent) => {
          if (onProgress && progressEvent.total) {
            const progress = Math.round(
              (progressEvent.loaded * 100) / progressEvent.total
            );
            onProgress(progress);
          }
        },
        timeout: 30000, // 30 second timeout
      });

      return {
        success: true,
        data: response.data,
        message: 'File uploaded successfully'
      };
      
    } catch (error) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response) {
        // Server responded with error status
        throw new Error(
          `Server error: ${axiosError.response.status} - ${
            (axiosError.response.data as any).message || axiosError.message
          }`
        );
      } else if (axiosError.request) {
        // Request was made but no response
        throw new Error('Network error: No response from server');
      } else {
        // Something else went wrong
        throw new Error(`Upload error: ${axiosError.message}`);
      }
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}