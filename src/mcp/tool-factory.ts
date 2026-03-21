import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as z from "zod";

import { toToolResult, withToolError } from "./result.ts";

interface RegisterToolOptions<TSchema extends z.ZodTypeAny> {
  title: string;
  description: string;
  inputSchema: TSchema;
  annotations?: Record<string, unknown>;
}

export function registerSafeTool<TSchema extends z.ZodTypeAny>(
  server: McpServer,
  name: string,
  options: RegisterToolOptions<TSchema>,
  handler: (args: z.infer<TSchema>) => Promise<unknown>
): void {
  const { title, description, inputSchema, annotations } = options;

  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema,
      ...(annotations ? { annotations } : {})
    },
    (async (args: Record<string, unknown>) =>
      withToolError(async () => {
        const parsedArgs = inputSchema.parse(args) as z.infer<TSchema>;
        const result = await handler(parsedArgs);
        return toToolResult(result);
      })) as any
  );
}
