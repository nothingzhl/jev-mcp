export type ErrorCode =
  | "INVALID_INPUT" | "CONFIGURATION" | "AUTHENTICATION" | "RATE_LIMIT"
  | "TIMEOUT" | "CONNECTION" | "UPSTREAM" | "INVALID_RESPONSE" | "STORAGE" | "INTERNAL";

export class JevError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "JevError";
  }
}

// Never forward SDK error bodies, arbitrary exceptions or user inputs to logs.
export function safeError(error: unknown): { code: ErrorCode; message: string } {
  return error instanceof JevError
    ? { code: error.code, message: error.message }
    : { code: "INTERNAL", message: "Unexpected local error; inspect the failing component with synthetic data." };
}
