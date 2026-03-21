import { formatToolError } from "./errors.ts";
import type { JsonObject } from "./types.ts";

export function toStructuredContent(data: unknown): JsonObject {
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    return data as JsonObject;
  }
  return { data };
}

export function toToolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: toStructuredContent(data)
  };
}

export async function withToolError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(formatToolError(error));
  }
}
