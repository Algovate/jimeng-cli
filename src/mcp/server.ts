import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import environment from "@/lib/environment.ts";
import type { McpConfig } from "./config.ts";
import { JimengApiClient } from "./client.ts";
import { registerMcpTools } from "./tools/index.ts";

export function createJimengMcpServer(config: McpConfig): McpServer {
  const server = new McpServer({
    name: "jimeng-cli-mcp",
    version: environment.package.version || "1.0.0"
  });

  const client = new JimengApiClient(config);
  registerMcpTools({ server, config, client });

  return server;
}
