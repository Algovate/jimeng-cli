import { assertRunConfirm } from "../guards.ts";
import { generateVideoInputSchema } from "../schemas.ts";
import type { ToolDeps } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";
import { buildBaseVideoPayload } from "./video-utils.ts";

export function registerGenerateVideoTool({ server, config, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "generate_video_flf",
    {
      title: "Generate Video FLF",
      description: "Generate video for first_last_frames workflow only",
      inputSchema: generateVideoInputSchema
    },
    async (args) => {
      assertRunConfirm(config, args.confirm);

      return client.generateVideo(
        buildBaseVideoPayload(args, "first_last_frames"),
        { token: args.token }
      );
    }
  );
}
