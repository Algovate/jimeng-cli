import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpConfig } from "./config.ts";
import type { JimengApiClient } from "./client.ts";

export type JsonObject = Record<string, unknown>;

export interface ToolDeps {
  server: McpServer;
  config: McpConfig;
  client: JimengApiClient;
}

export interface MultipartUploadFile {
  fieldName: string;
  filePath: string;
}
