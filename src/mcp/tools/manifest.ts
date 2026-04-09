import type { ToolDeps } from "../types.ts";
import { registerEditImageTool } from "./edit-image.ts";
import { registerGenerateImageTool } from "./generate-image.ts";
import { registerGenerateVideoOmniTool } from "./generate-video-omni.ts";
import { registerGenerateVideoTool } from "./generate-video.ts";
import { registerGetTaskTool } from "./get-task.ts";
import { registerHealthCheckTool } from "./health-check.ts";
import { registerListModelsTool } from "./list-models.ts";
import { registerListTasksTool } from "./list-tasks.ts";
import { registerUpscaleImageTool } from "./upscale-image.ts";
import { registerWaitTaskTool } from "./wait-task.ts";

export interface McpToolManifestItem {
  id: string;
  isAdvanced?: boolean;
  register: (deps: ToolDeps) => void;
}

export const MCP_TOOL_MANIFEST: McpToolManifestItem[] = [
  { id: "health_check", register: registerHealthCheckTool },
  { id: "list_models", register: registerListModelsTool },
  { id: "get_task", register: registerGetTaskTool },
  { id: "wait_task", register: registerWaitTaskTool },
  { id: "list_tasks", register: registerListTasksTool },
  { id: "generate_image", register: registerGenerateImageTool },
  { id: "upscale_image", isAdvanced: true, register: registerUpscaleImageTool },
  { id: "edit_image", isAdvanced: true, register: registerEditImageTool },
  { id: "generate_video_flf", isAdvanced: true, register: registerGenerateVideoTool },
  { id: "generate_video_omni", isAdvanced: true, register: registerGenerateVideoOmniTool }
];
