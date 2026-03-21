import axios from "axios";

export type McpToolErrorCode =
  | "CONFIG_ERROR"
  | "VALIDATION_ERROR"
  | "AUTH_ERROR"
  | "NETWORK_ERROR"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export class McpToolError extends Error {
  code: McpToolErrorCode;
  details?: unknown;

  constructor(code: McpToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function normalizeToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;

  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return new McpToolError(
        "NETWORK_ERROR",
        "Failed to reach jimeng-cli service",
        error.message
      );
    }

    const status = error.response.status;
    const message =
      String(error.response.data?.error?.message || error.response.data?.message || error.message);

    if (status === 401 || status === 403) {
      return new McpToolError("AUTH_ERROR", message, error.response.data);
    }
    if (status >= 400 && status < 500) {
      return new McpToolError("VALIDATION_ERROR", message, error.response.data);
    }
    if (status >= 500) {
      return new McpToolError("UPSTREAM_ERROR", message, error.response.data);
    }
  }

  if (error instanceof Error) {
    return new McpToolError("INTERNAL_ERROR", error.message);
  }

  return new McpToolError("INTERNAL_ERROR", "Unknown internal error");
}

export function formatToolError(error: unknown): string {
  const normalized = normalizeToolError(error);
  return `[${normalized.code}] ${normalized.message}`;
}
