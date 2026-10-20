import { RelayError } from "@relay/contracts";

export function isBrokenPipe(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EPIPE";
}

export class CliUsageError extends RelayError {
  override readonly name = "CliUsageError";

  constructor(message: string, code = "INVALID_ARGUMENT") {
    super(code, message, 2);
  }
}
