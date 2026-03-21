import { waitTaskInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerWaitTaskTool({ server, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "wait_task",
    {
      title: "Wait Task",
      description: "Wait for image/video task completion by task_id",
      inputSchema: waitTaskInputSchema
    },
    async (args) => client.waitTask(
      args.task_id,
      {
        type: args.type,
        response_format: args.response_format,
        wait_timeout_seconds: args.wait_timeout_seconds,
        poll_interval_ms: args.poll_interval_ms
      },
      { token: args.token }
    )
  );
}
