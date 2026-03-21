import { getTaskInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerGetTaskTool({ server, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "get_task",
    {
      title: "Get Task",
      description: "Get image/video task status by task_id",
      inputSchema: getTaskInputSchema,
      annotations: { readOnlyHint: true }
    },
    async (args) => client.getTask(
      args.task_id,
      { token: args.token },
      {
        type: args.type,
        response_format: args.response_format
      }
    )
  );
}
