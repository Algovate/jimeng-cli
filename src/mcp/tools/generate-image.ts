import { assertRunConfirm } from "../guards.ts";
import { generateImageInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerGenerateImageTool({ server, config, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "generate_image",
    {
      title: "Generate Image",
      description: "Generate image from prompt",
      inputSchema: generateImageInputSchema
    },
    async (args) => {
      assertRunConfirm(config, args.confirm);

      return client.generateImage(
        {
          prompt: args.prompt,
          model: args.model,
          negative_prompt: args.negative_prompt,
          ratio: args.ratio,
          resolution: args.resolution || "1k",
          intelligent_ratio: args.intelligent_ratio,
          sample_strength: args.sample_strength,
          response_format: args.response_format,
          wait: args.wait,
          wait_timeout_seconds: args.wait_timeout_seconds,
          poll_interval_ms: args.poll_interval_ms
        },
        { token: args.token }
      );
    }
  );
}
