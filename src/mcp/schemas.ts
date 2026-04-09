import * as z from "zod";

function buildIndexedUrlFields(prefix: "image_file" | "video_file", max: number) {
  return Object.fromEntries(
    Array.from({ length: max }, (_, index) => [
      `${prefix}_${index + 1}`,
      z.string().url().optional()
    ])
  );
}

function normalizeUniqueValues(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export const healthCheckInputSchema = z.object({});

export const listModelsInputSchema = z.object({
  token: z.string().optional()
});

export const generateImageInputSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  negative_prompt: z.string().optional(),
  ratio: z.string().optional(),
  resolution: z.string().optional(),
  intelligent_ratio: z.boolean().optional(),
  sample_strength: z.number().optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  wait: z.boolean().optional(),
  wait_timeout_seconds: z.number().int().positive().optional(),
  poll_interval_ms: z.number().int().positive().optional(),
  token: z.string().optional(),
  confirm: z.string().optional()
});

export const editImageInputSchema = z.object({
  prompt: z.string().min(1),
  images: z.array(z.string().url()).min(1).max(10),
  model: z.string().optional(),
  negative_prompt: z.string().optional(),
  ratio: z.string().optional(),
  resolution: z.string().optional(),
  intelligent_ratio: z.boolean().optional(),
  sample_strength: z.number().optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  wait: z.boolean().optional(),
  wait_timeout_seconds: z.number().int().positive().optional(),
  poll_interval_ms: z.number().int().positive().optional(),
  token: z.string().optional(),
  confirm: z.string().optional()
});

export const generateVideoInputSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  ratio: z.string().optional(),
  resolution: z.string().optional(),
  duration: z.number().int().min(4).max(15).optional(),
  wait: z.boolean().optional(),
  wait_timeout_seconds: z.number().int().positive().optional(),
  poll_interval_ms: z.number().int().positive().optional(),
  token: z.string().optional(),
  confirm: z.string().optional()
});

export const generateVideoOmniInputSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    ratio: z.string().optional(),
    resolution: z.string().optional(),
    duration: z.number().int().min(4).max(15).optional(),
    response_format: z.enum(["url", "b64_json"]).optional(),
    wait: z.boolean().optional(),
    wait_timeout_seconds: z.number().int().positive().optional(),
    poll_interval_ms: z.number().int().positive().optional(),
    file_paths: z.array(z.string().url()).max(9).optional(),
    filePaths: z.array(z.string().url()).max(9).optional(),
    image_urls: z.array(z.string().url()).max(9).optional(),
    video_urls: z.array(z.string().url()).max(3).optional(),
    image_files: z.array(z.string()).max(9).optional(),
    video_files: z.array(z.string()).max(3).optional(),
    ...buildIndexedUrlFields("image_file", 9),
    ...buildIndexedUrlFields("video_file", 3),
    token: z.string().optional(),
    confirm: z.string().optional()
  })
  .superRefine((value, ctx) => {
    const imageSlotUrls = Array.from({ length: 9 }, (_, index) => value[`image_file_${index + 1}`]);
    const videoSlotUrls = Array.from({ length: 3 }, (_, index) => value[`video_file_${index + 1}`]);

    const imageCount =
      normalizeUniqueValues(value.image_urls || []).length +
      (value.image_files?.length || 0) +
      normalizeUniqueValues([...(value.file_paths || []), ...(value.filePaths || [])]).length +
      normalizeUniqueValues(imageSlotUrls.filter((item): item is string => typeof item === "string")).length;

    const videoCount =
      normalizeUniqueValues(value.video_urls || []).length +
      (value.video_files?.length || 0) +
      normalizeUniqueValues(videoSlotUrls.filter((item): item is string => typeof item === "string")).length;

    if (imageCount > 9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Omni mode supports at most 9 images."
      });
    }
    if (videoCount > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Omni mode supports at most 3 videos."
      });
    }
    if (imageCount + videoCount > 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Omni mode supports at most 12 total materials."
      });
    }
    if (imageCount + videoCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Omni mode requires at least one material."
      });
    }
  });

export const getTaskInputSchema = z.object({
  task_id: z.string().min(1),
  type: z.enum(["image", "video"]).optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  token: z.string().optional()
});

export const waitTaskInputSchema = z.object({
  task_id: z.string().min(1),
  type: z.enum(["image", "video"]).optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  wait_timeout_seconds: z.number().int().positive().optional(),
  poll_interval_ms: z.number().int().positive().optional(),
  token: z.string().optional()
});

export const upscaleImageInputSchema = z.object({
  image: z.string().min(1).describe("Image URL or local file path to upscale"),
  model: z.string().optional(),
  resolution: z.enum(["2k", "4k"]).optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  wait: z.boolean().optional(),
  wait_timeout_seconds: z.number().int().positive().optional(),
  poll_interval_ms: z.number().int().positive().optional(),
  token: z.string().optional(),
  confirm: z.string().optional()
});

export const listTasksInputSchema = z.object({
  type: z.enum(["image", "video", "all"]).optional(),
  count: z.number().int().positive().max(100).optional(),
  token: z.string().optional()
});
