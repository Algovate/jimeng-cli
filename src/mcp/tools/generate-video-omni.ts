import type { z } from "zod";

import { assertRunConfirm } from "../guards.ts";
import { generateVideoOmniInputSchema } from "../schemas.ts";
import type { MultipartUploadFile, ToolDeps } from "../types.ts";
import type { JsonObject } from "../types.ts";
import { registerSafeTool } from "../tool-factory.ts";
import {
  appendFileMaterials,
  appendUrlMaterials,
  assertLocalFilesExist,
  buildBaseVideoPayload,
  collectIndexedSlotUrls,
  collectStringArray,
  MAX_IMAGE_SLOTS,
  MAX_VIDEO_SLOTS,
  uniqueStrings
} from "./video-utils.ts";

type GenerateVideoOmniArgs = z.infer<typeof generateVideoOmniInputSchema>;

function normalizeOmniPayload(args: GenerateVideoOmniArgs): {
  body: JsonObject;
  uploadFiles: MultipartUploadFile[];
} {
  const imageSlotUrls = collectIndexedSlotUrls(args, "image_file", MAX_IMAGE_SLOTS);
  const videoSlotUrls = collectIndexedSlotUrls(args, "video_file", MAX_VIDEO_SLOTS);
  const imageUrls = uniqueStrings([
    ...collectStringArray(args.image_urls),
    ...collectStringArray(args.file_paths),
    ...collectStringArray(args.filePaths)
  ]);
  const videoUrls = uniqueStrings(collectStringArray(args.video_urls));
  const imageFiles = uniqueStrings(collectStringArray(args.image_files));
  const videoFiles = uniqueStrings(collectStringArray(args.video_files));

  assertLocalFilesExist(imageFiles);
  assertLocalFilesExist(videoFiles);

  const body: JsonObject = buildBaseVideoPayload(args, "omni_reference");

  for (const [slot, url] of imageSlotUrls) {
    body[`image_file_${slot}`] = url;
  }
  for (const [slot, url] of videoSlotUrls) {
    body[`video_file_${slot}`] = url;
  }

  const occupiedImageSlots = new Set<number>(imageSlotUrls.keys());
  const occupiedVideoSlots = new Set<number>(videoSlotUrls.keys());

  appendUrlMaterials(body, occupiedImageSlots, imageUrls, "image_file", MAX_IMAGE_SLOTS, "image");
  appendUrlMaterials(body, occupiedVideoSlots, videoUrls, "video_file", MAX_VIDEO_SLOTS, "video");

  const uploadFiles: MultipartUploadFile[] = [];
  appendFileMaterials(
    uploadFiles,
    occupiedImageSlots,
    imageFiles,
    "image_file",
    MAX_IMAGE_SLOTS,
    "image"
  );
  appendFileMaterials(
    uploadFiles,
    occupiedVideoSlots,
    videoFiles,
    "video_file",
    MAX_VIDEO_SLOTS,
    "video"
  );

  return { body, uploadFiles };
}

export function registerGenerateVideoOmniTool({ server, config, client }: ToolDeps): void {
  registerSafeTool(
    server,
    "generate_video_omni",
    {
      title: "Generate Video Omni",
      description: "Generate omni_reference video with URL and local-file materials",
      inputSchema: generateVideoOmniInputSchema
    },
    async (args: GenerateVideoOmniArgs) => {
      assertRunConfirm(config, args.confirm);
      const { body, uploadFiles } = normalizeOmniPayload(args);
      return client.generateVideoOmni(body, { token: args.token }, uploadFiles);
    }
  );
}
