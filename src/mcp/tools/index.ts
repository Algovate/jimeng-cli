import type { ToolDeps } from "../types.ts";
import { MCP_TOOL_MANIFEST } from "./manifest.ts";

export function registerMcpTools(deps: ToolDeps): void {
  for (const item of MCP_TOOL_MANIFEST) {
    if (item.isAdvanced && !deps.config.enableAdvancedTools) continue;
    item.register(deps);
  }
}
