import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadMcpConfig } from "./config.ts";
import { createJimengMcpServer } from "./server.ts";

async function main() {
  const config = loadMcpConfig();
  const server = createJimengMcpServer(config);
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
  console.error("[jimeng-cli-mcp] Server started on stdio transport");
}

main().catch((error) => {
  console.error("[jimeng-cli-mcp] Failed to start MCP server:", error);
  process.exit(1);
});
