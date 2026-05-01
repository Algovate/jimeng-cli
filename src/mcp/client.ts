import fs from "node:fs";
import path from "node:path";

import { DEFAULT_IMAGE_MODEL } from "@/api/constants/common.ts";
import { buildRegionInfo, type RegionCode } from "@/api/services/core.ts";
import { generateImageComposition, generateImages, upscaleImage } from "@/api/services/images.ts";
import { getLiveModels } from "@/api/services/models.ts";
import { getTaskResponse, waitForTaskResponse, getAssetList } from "@/api/services/tasks.ts";
import { DEFAULT_MODEL as DEFAULT_VIDEO_MODEL, generateVideo } from "@/api/services/videos.ts";
import tokenPool from "@/core/runtime/session-pool.ts";
import util from "@/core/utils/util.ts";
import logger from "@/core/utils/logger.ts";

import type { McpConfig } from "./config.ts";
import type { JsonObject, MultipartUploadFile } from "./types.ts";

export interface McpRequestOptions {
  token?: string;
  includeManual?: boolean;
}

function resolveTaskType(value: unknown): "image" | "video" {
  return value === "video" ? "video" : "image";
}

export class JimengApiClient {
  private readonly defaultToken?: string;
  private tokenPoolReady = false;

  constructor(config: McpConfig) {
    this.defaultToken = config.apiToken;
  }

  private resolveToken(options?: McpRequestOptions): string | undefined {
    return options?.token || this.defaultToken;
  }

  private async ensureTokenPoolReady(): Promise<void> {
    if (this.tokenPoolReady) return;
    await tokenPool.init();
    this.tokenPoolReady = true;
  }

  private async pickModelToken(
    requestedModel: string,
    taskType: "image" | "video",
    options?: McpRequestOptions,
    requiredCapabilityTags: string[] = []
  ): Promise<{ token: string; regionInfo: any }> {
    await this.ensureTokenPoolReady();
    const token = this.resolveToken(options);
    const tokenPick = tokenPool.pickTokenForRequest({
      authorization: token ? `Bearer ${token}` : undefined,
      requestedModel,
      taskType,
      requiredCapabilityTags,
    });

    if (!tokenPick.token || !tokenPick.region) {
      throw new Error(tokenPick.reason || "Missing available token for model request");
    }

    return {
      token: tokenPick.token,
      regionInfo: buildRegionInfo(tokenPick.region),
    };
  }

  private async pickTaskToken(
    options?: McpRequestOptions,
    type: "image" | "video" = "image"
  ): Promise<{ token: string; regionInfo: any }> {
    await this.ensureTokenPoolReady();
    const token = this.resolveToken(options);
    if (token) {
      const entry = tokenPool.getTokenEntry(token);
      if (!entry?.region) {
        throw new Error("Missing region for token. Register token with region in token-pool.");
      }
      return { token, regionInfo: buildRegionInfo(entry.region) };
    }

    const candidates = tokenPool
      .getEntries(false)
      .filter((item) => item.enabled && item.live !== false && item.region)
      .filter((item) => {
        if (!item.allowedModels?.length) return true;
        // For task operations we just need any matching token, not model-specific
        return true;
      });
    if (candidates.length === 0) {
      throw new Error("No token available for task request. Configure token-pool or pass token.");
    }
    return { token: candidates[0].token, regionInfo: buildRegionInfo(candidates[0].region as RegionCode) };
  }

  async healthCheck(): Promise<any> {
    return "pong";
  }

  async listModels(options?: McpRequestOptions): Promise<any> {
    await this.ensureTokenPoolReady();
    const token = this.resolveToken(options);
    const authorization = token ? `Bearer ${token}` : undefined;
    const region = token ? tokenPool.getTokenEntry(token)?.region : undefined;
    const result = await getLiveModels(authorization, region, {
      includeManual: options?.includeManual,
    });
    return {
      source: result.source,
      data: result.data,
    };
  }

  async generateImage(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    const model = typeof body.model === "string" && body.model.trim().length > 0
      ? body.model
      : DEFAULT_IMAGE_MODEL;
    const prompt = String(body.prompt || "");
    const tokenCtx = await this.pickModelToken(model, "image", options);

    const responseFormat = body.response_format === "b64_json" ? "b64_json" : "url";
    const imageResult = await generateImages(
      model,
      prompt,
      {
        ratio: body.ratio as string | undefined,
        resolution: body.resolution as string | undefined,
        sampleStrength: body.sample_strength as number | undefined,
        negativePrompt: body.negative_prompt as string | undefined,
        intelligentRatio: body.intelligent_ratio as boolean | undefined,
        wait: body.wait as boolean | undefined,
        waitTimeoutSeconds: body.wait_timeout_seconds as number | undefined,
        pollIntervalMs: body.poll_interval_ms as number | undefined,
      },
      tokenCtx.token,
      tokenCtx.regionInfo
    );

    if (!Array.isArray(imageResult)) {
      return imageResult;
    }

    const data = responseFormat === "b64_json"
      ? (await Promise.all(imageResult.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
      : imageResult.map((url) => ({ url }));

    return {
      created: util.unixTimestamp(),
      data,
    };
  }

  async editImage(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    const model = typeof body.model === "string" && body.model.trim().length > 0
      ? body.model
      : DEFAULT_IMAGE_MODEL;
    const prompt = String(body.prompt || "");
    const images = Array.isArray(body.images)
      ? body.images.filter((item): item is string => typeof item === "string")
      : [];
    const tokenCtx = await this.pickModelToken(model, "image", options);

    const responseFormat = body.response_format === "b64_json" ? "b64_json" : "url";
    const compositionResult = await generateImageComposition(
      model,
      prompt,
      images,
      {
        ratio: body.ratio as string | undefined,
        resolution: body.resolution as string | undefined,
        sampleStrength: body.sample_strength as number | undefined,
        negativePrompt: body.negative_prompt as string | undefined,
        intelligentRatio: body.intelligent_ratio as boolean | undefined,
        wait: body.wait as boolean | undefined,
        waitTimeoutSeconds: body.wait_timeout_seconds as number | undefined,
        pollIntervalMs: body.poll_interval_ms as number | undefined,
      },
      tokenCtx.token,
      tokenCtx.regionInfo
    );

    if (!Array.isArray(compositionResult)) {
      return compositionResult;
    }

    const data = responseFormat === "b64_json"
      ? (await Promise.all(compositionResult.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
      : compositionResult.map((url) => ({ url }));

    return {
      created: util.unixTimestamp(),
      data,
      input_images: images.length,
      composition_type: "multi_image_synthesis",
    };
  }

  async generateVideo(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    const model = typeof body.model === "string" && body.model.trim().length > 0
      ? body.model
      : DEFAULT_VIDEO_MODEL;
    const prompt = String(body.prompt || "");

    const functionMode = typeof body.functionMode === "string" ? body.functionMode : "first_last_frames";
    const requiredTags = functionMode === "omni_reference" ? ["omni_reference"] : [];
    const tokenCtx = await this.pickModelToken(model, "video", options, requiredTags);

    const videoResult = await generateVideo(
      model,
      prompt,
      {
        ratio: body.ratio as string | undefined,
        resolution: body.resolution as string | undefined,
        duration: body.duration as number | undefined,
        filePaths: (body.filePaths || body.file_paths) as string[] | undefined,
        files: body.files as any,
        httpRequest: { body } as any,
        functionMode,
        wait: body.wait as boolean | undefined,
        waitTimeoutSeconds: body.wait_timeout_seconds as number | undefined,
        pollIntervalMs: body.poll_interval_ms as number | undefined,
      },
      tokenCtx.token,
      tokenCtx.regionInfo
    );

    if (typeof videoResult !== "string") {
      return videoResult;
    }

    if (body.response_format === "b64_json") {
      logger.warn("Video b64_json mode is not recommended — video files can be very large. Using URL mode instead.");
      return {
        created: util.unixTimestamp(),
        data: [{ url: videoResult, revised_prompt: prompt }],
      };
    }

    return {
      created: util.unixTimestamp(),
      data: [{ url: videoResult, revised_prompt: prompt }],
    };
  }

  async getTask(
    taskId: string,
    options?: McpRequestOptions,
    query?: { type?: string; response_format?: string }
  ): Promise<any> {
    const type = query?.type === "video" ? "video" : query?.type === "image" ? "image" : undefined;
    const tokenCtx = await this.pickTaskToken(options, resolveTaskType(type));
    return getTaskResponse(taskId, tokenCtx.token, tokenCtx.regionInfo, {
      type,
      responseFormat: query?.response_format === "b64_json" ? "b64_json" : "url",
    });
  }

  async waitTask(
    taskId: string,
    body: Record<string, unknown>,
    options?: McpRequestOptions
  ): Promise<any> {
    const type = body.type === "video" ? "video" : body.type === "image" ? "image" : undefined;
    const tokenCtx = await this.pickTaskToken(options, resolveTaskType(type));
    return waitForTaskResponse(taskId, tokenCtx.token, tokenCtx.regionInfo, {
      type,
      responseFormat: body.response_format === "b64_json" ? "b64_json" : "url",
      waitTimeoutSeconds: body.wait_timeout_seconds as number | undefined,
      pollIntervalMs: body.poll_interval_ms as number | undefined,
    });
  }

  async generateVideoOmni(
    body: JsonObject,
    options?: McpRequestOptions,
    uploadFiles: MultipartUploadFile[] = []
  ): Promise<any> {
    const files: Record<string, any> = {};
    for (const file of uploadFiles) {
      files[file.fieldName] = {
        filepath: file.filePath,
        originalFilename: path.basename(file.filePath),
      };
      if (!fs.existsSync(file.filePath)) {
        throw new Error(`Local file not found: ${file.filePath}`);
      }
    }

    return this.generateVideo(
      {
        ...body,
        functionMode: "omni_reference",
        files,
      },
      options
    );
  }

  async upscaleImage(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    const model = typeof body.model === "string" && body.model.trim().length > 0
      ? body.model
      : DEFAULT_IMAGE_MODEL;
    const imageUrl = typeof body.image === "string" ? body.image : "";
    if (!imageUrl) throw new Error("Missing required 'image' field (URL or base64)");

    const tokenCtx = await this.pickModelToken(model, "image", options);

    const responseFormat = body.response_format === "b64_json" ? "b64_json" : "url";
    const upscaleResult = await upscaleImage(
      model,
      imageUrl,
      {
        resolution: body.resolution as string | undefined,
        wait: body.wait as boolean | undefined,
        waitTimeoutSeconds: body.wait_timeout_seconds as number | undefined,
        pollIntervalMs: body.poll_interval_ms as number | undefined,
      },
      tokenCtx.token,
      tokenCtx.regionInfo
    );

    if (!Array.isArray(upscaleResult)) {
      return upscaleResult;
    }

    const data = responseFormat === "b64_json"
      ? (await Promise.all(upscaleResult.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({ b64_json: b64 }))
      : upscaleResult.map((url) => ({ url }));

    return {
      created: util.unixTimestamp(),
      data,
      resolution: body.resolution || "4k",
    };
  }

  async listTasks(options?: McpRequestOptions, query?: { type?: string; count?: number }): Promise<any> {
    const tokenCtx = await this.pickTaskToken(options);
    const result = await getAssetList(tokenCtx.token, tokenCtx.regionInfo, {
      count: query?.count || 20,
      type: (query?.type as "image" | "video" | "all") || "all",
    });

    return {
      has_more: result.hasMore,
      next_offset: result.nextOffset,
      total: result.items.length,
      items: result.items,
    };
  }
}
