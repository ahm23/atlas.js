
export class CancellationException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CancellationException';
  }
}

export class FileNotInQueue extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotInQueue';
  }
}