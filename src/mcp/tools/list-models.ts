import { listModelsInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerListModelsTool({ server, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "list_models",
    {
      title: "List Models",
      description: "Get available models from jimeng-cli",
      inputSchema: listModelsInputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ token }) => client.listModels({ token })
  );
}
