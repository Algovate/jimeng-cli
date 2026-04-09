import { assertRunConfirm } from "../guards.ts";
import { upscaleImageInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";

export function registerUpscaleImageTool({ server, config, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "upscale_image",
    {
      title: "Upscale Image",
      description: "Upscale an existing image to higher resolution (2k or 4k) using super_resolution",
      inputSchema: upscaleImageInputSchema
    },
    async (args) => {
      assertRunConfirm(config, args.confirm);

      return client.upscaleImage(
        {
          image: args.image,
          model: args.model,
          resolution: args.resolution || "4k",
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
