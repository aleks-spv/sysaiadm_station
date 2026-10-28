// Thrown when a file is not in the expected format. Never includes file content.
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}
