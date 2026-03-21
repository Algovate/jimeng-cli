import type { ToolDeps } from "../types.ts";
import { healthCheckInputSchema } from "../schemas.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerHealthCheckTool({ server, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "health_check",
    {
      title: "Health Check",
      description: "Check jimeng-cli health endpoint",
      inputSchema: healthCheckInputSchema
    },
    async () => {
      const startedAt = Date.now();
      const raw = await client.healthCheck();
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        raw
      };
    }
  );
}
