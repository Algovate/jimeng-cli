import type { McpConfig } from "./config.ts";
import { McpToolError } from "./errors.ts";

export function assertRunConfirm(config: McpConfig, confirm?: string): void {
  if (!config.requireRunConfirm) return;
  if (confirm === "RUN") return;

  throw new McpToolError(
    "VALIDATION_ERROR",
    'This tool requires explicit confirmation: set "confirm" to "RUN".'
  );
}
