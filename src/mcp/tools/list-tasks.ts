import { listTasksInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerListTasksTool({ server, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "list_tasks",
    {
      title: "List Tasks",
      description: "List generation task history with optional type filter",
      inputSchema: listTasksInputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args) => client.listTasks(
      { token: args.token },
      {
        type: args.type,
        count: args.count
      }
    )
  );
}
