import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import minimist from "minimist";

import { buildRegionInfo, type RegionCode } from "@/api/controllers/core.ts";
import { generateImageComposition, generateImages, upscaleImage } from "@/api/controllers/images.ts";
import { generateVideo } from "@/api/controllers/videos.ts";
import {
  VIDEO_OMNI_IMAGE_SLOT_KEYS,
  VIDEO_OMNI_VIDEO_SLOT_KEYS,
  buildDirectVideoInputPayload,
  collectVideoInputPlan,
  parseVideoCliMode,
  validateVideoModeAndModel,
  type VideoCliMode
} from "@/cli/video-input.ts";

type JsonRecord = Record<string, unknown>;

type MediaDeps = {
  usageImageGenerate: () => string;
  usageImageEdit: () => string;
  usageImageUpscale: () => string;
  usageVideoGenerate: () => string;
  getSingleString: (args: Record<string, unknown>, key: string) => string | undefined;
  getRegionWithDefault: (args: Record<string, unknown>) => string;
  toStringList: (raw: unknown) => string[];
  fail: (message: string) => never;
  failWithUsage: (reason: string, usage: string) => never;
  pickDirectTokenForGeneration: (
    token: string | undefined,
    region: string | undefined,
    requestedModel: string,
    taskType: "image" | "video",
    requiredCapabilityTags?: string[]
  ) => Promise<{ token: string; region: RegionCode }>;
  printCommandJson: (command: string, data: unknown, meta?: JsonRecord) => void;
  printDownloadSummary: (kind: "image" | "video", files: string[]) => void;
  printTaskInfo: (task: unknown) => void;
};

function ensurePrompt(prompt: string | undefined, usage: string, deps: Pick<MediaDeps, "fail">): string {
  if (!prompt) {
    deps.fail(`Missing required --prompt.\n\n${usage}`);
  }
  return prompt;
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function detectImageExtension(contentType: string | null): string | null {
  if (!contentType) return null;
  if (contentType.includes("image/jpeg")) return "jpg";
  if (contentType.includes("image/png")) return "png";
  if (contentType.includes("image/webp")) return "webp";
  if (contentType.includes("image/gif")) return "gif";
  return null;
}

function detectImageExtensionFromUrl(fileUrl: string): string | null {
  try {
    const pathname = new URL(fileUrl).pathname.toLowerCase();
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpg";
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
    if (pathname.endsWith(".gif")) return "gif";
  } catch {
    return null;
  }
  return null;
}

function detectImageExtensionFromBuffer(buffer: Buffer): string | null {
  if (buffer.length >= 8) {
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) return "png";
  }
  if (buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  }
  if (buffer.length >= 12) {
    if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) return "webp";
  }
  if (buffer.length >= 6) {
    const sig = buffer.toString("ascii", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return "gif";
  }
  return null;
}

function detectVideoExtension(contentType: string | null, fileUrl: string): string {
  if (contentType?.includes("video/mp4")) return "mp4";
  if (contentType?.includes("video/webm")) return "webm";
  const pathname = new URL(fileUrl).pathname.toLowerCase();
  if (pathname.endsWith(".mp4")) return "mp4";
  if (pathname.endsWith(".webm")) return "webm";
  if (pathname.endsWith(".mov")) return "mov";
  return "mp4";
}

function parsePositiveNumberOption(
  args: Record<string, unknown>,
  key: "wait-timeout-seconds" | "poll-interval-ms",
  deps: Pick<MediaDeps, "getSingleString" | "fail">
): number | undefined {
  const raw = deps.getSingleString(args, key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    deps.fail(`Invalid --${key}: ${raw}`);
  }
  return parsed;
}

function applyWaitOptionsToBody(
  body: JsonRecord,
  args: Record<string, unknown>,
  deps: Pick<MediaDeps, "getSingleString" | "fail">,
  includeWaitFlag = true
): boolean {
  const wait = Boolean(args.wait);
  if (includeWaitFlag) body.wait = wait;
  const waitTimeoutSeconds = parsePositiveNumberOption(args, "wait-timeout-seconds", deps);
  if (waitTimeoutSeconds !== undefined) body.wait_timeout_seconds = waitTimeoutSeconds;
  const pollIntervalMs = parsePositiveNumberOption(args, "poll-interval-ms", deps);
  if (pollIntervalMs !== undefined) body.poll_interval_ms = pollIntervalMs;
  return wait;
}

async function downloadBinary(url: string, deps: Pick<MediaDeps, "fail">): Promise<{ buffer: Buffer; contentType: string | null }> {
  const response = await fetch(url);
  if (!response.ok) {
    deps.fail(`Download failed (${response.status}): ${url}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
  };
}

async function downloadImages(
  urls: string[],
  outputDir: string,
  prefix: string,
  deps: Pick<MediaDeps, "fail">
): Promise<string[]> {
  const dir = path.resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const saved: string[] = [];

  for (let i = 0; i < urls.length; i += 1) {
    const imageUrl = urls[i];
    const { buffer, contentType } = await downloadBinary(imageUrl, deps);
    const ext =
      detectImageExtension(contentType) ??
      detectImageExtensionFromBuffer(buffer) ??
      detectImageExtensionFromUrl(imageUrl) ??
      "png";
    const fileName = `${prefix}-${timestamp}-${String(i + 1).padStart(2, "0")}.${ext}`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, buffer);
    saved.push(filePath);
  }

  return saved;
}

export function createMediaCommandHandlers(deps: MediaDeps): {
  handleImageGenerate: (argv: string[]) => Promise<void>;
  handleImageEdit: (argv: string[]) => Promise<void>;
  handleImageUpscale: (argv: string[]) => Promise<void>;
  handleVideoGenerate: (argv: string[]) => Promise<void>;
} {
  const handleImageGenerate = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: [
        "token",
        "region",
        "prompt",
        "model",
        "ratio",
        "resolution",
        "negative-prompt",
        "sample-strength",
        "output-dir",
        "wait-timeout-seconds",
        "poll-interval-ms",
      ],
      boolean: ["help", "intelligent-ratio", "wait", "json"],
      default: { wait: true },
    });

    if (args.help) {
      console.log(deps.usageImageGenerate());
      return;
    }

    const token = deps.getSingleString(args, "token");
    const region = deps.getRegionWithDefault(args);
    const prompt = ensurePrompt(deps.getSingleString(args, "prompt"), deps.usageImageGenerate(), deps);
    const outputDir = deps.getSingleString(args, "output-dir") || "./pic/cli-image-generate";

    const body: JsonRecord = {
      prompt,
      model: deps.getSingleString(args, "model") || "jimeng-4.5",
      ratio: deps.getSingleString(args, "ratio") || "1:1",
      resolution: deps.getSingleString(args, "resolution") || "2k",
    };

    const negativePrompt = deps.getSingleString(args, "negative-prompt");
    if (negativePrompt) body.negative_prompt = negativePrompt;
    if (args["intelligent-ratio"]) body.intelligent_ratio = true;
    const wait = applyWaitOptionsToBody(body, args, deps);
    const isJson = Boolean(args.json);

    const sampleStrengthRaw = deps.getSingleString(args, "sample-strength");
    if (sampleStrengthRaw) {
      const parsed = Number(sampleStrengthRaw);
      if (!Number.isFinite(parsed)) {
        deps.fail(`Invalid --sample-strength: ${sampleStrengthRaw}`);
      }
      body.sample_strength = parsed;
    }

    const pick = await deps.pickDirectTokenForGeneration(
      token,
      region,
      String(body.model || "jimeng-4.5"),
      "image"
    );
    const result = await generateImages(
      String(body.model || "jimeng-4.5"),
      String(prompt),
      {
        ratio: String(body.ratio || "1:1"),
        resolution: String(body.resolution || "2k"),
        sampleStrength: typeof body.sample_strength === "number" ? body.sample_strength : undefined,
        negativePrompt: typeof body.negative_prompt === "string" ? body.negative_prompt : undefined,
        intelligentRatio: Boolean(body.intelligent_ratio),
        wait,
        waitTimeoutSeconds: typeof body.wait_timeout_seconds === "number" ? body.wait_timeout_seconds : undefined,
        pollIntervalMs: typeof body.poll_interval_ms === "number" ? body.poll_interval_ms : undefined,
      },
      pick.token,
      buildRegionInfo(pick.region)
    );
    if (!Array.isArray(result)) {
      if (isJson) deps.printCommandJson("image.generate", result, { wait });
      else deps.printTaskInfo(result);
      return;
    }
    const urls: string[] = result;
    if (urls.length === 0) deps.fail("No image URL found in response.");

    const savedFiles = await downloadImages(urls, outputDir, "jimeng-image-generate", deps);
    if (isJson) {
      deps.printCommandJson(
        "image.generate",
        { data: urls.map((url) => ({ url })), files: savedFiles },
        { wait }
      );
    } else {
      deps.printDownloadSummary("image", savedFiles);
    }
  };

  const handleImageEdit = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: [
        "token",
        "region",
        "prompt",
        "image",
        "model",
        "ratio",
        "resolution",
        "negative-prompt",
        "sample-strength",
        "output-dir",
        "wait-timeout-seconds",
        "poll-interval-ms",
      ],
      boolean: ["help", "intelligent-ratio", "wait", "json"],
      default: { wait: true },
    });

    if (args.help) {
      console.log(deps.usageImageEdit());
      return;
    }

    const token = deps.getSingleString(args, "token");
    const region = deps.getRegionWithDefault(args);
    const prompt = ensurePrompt(deps.getSingleString(args, "prompt"), deps.usageImageEdit(), deps);
    const sources = deps.toStringList(args.image);
    if (sources.length === 0) deps.failWithUsage("Missing required --image.", deps.usageImageEdit());
    if (sources.length > 10) deps.fail("At most 10 images are supported for image edit.");

    const outputDir = deps.getSingleString(args, "output-dir") || "./pic/cli-image-edit";
    const model = deps.getSingleString(args, "model") || "jimeng-4.5";
    const ratio = deps.getSingleString(args, "ratio") || "1:1";
    const resolution = deps.getSingleString(args, "resolution") || "2k";
    const negativePrompt = deps.getSingleString(args, "negative-prompt");
    const sampleStrengthRaw = deps.getSingleString(args, "sample-strength");
    const intelligentRatio = Boolean(args["intelligent-ratio"]);
    const wait = Boolean(args.wait);
    const isJson = Boolean(args.json);

    const allUrls = sources.every(isHttpUrl);
    const allLocal = sources.every((item) => !isHttpUrl(item));
    if (!allUrls && !allLocal) {
      deps.fail("Mixed image sources are not supported. Use all URLs or all local files.");
    }

    const pick = await deps.pickDirectTokenForGeneration(token, region, model, "image");
    const images: Array<string | Buffer> = [];
    if (allUrls) {
      images.push(...sources);
    } else {
      for (const source of sources) {
        const imagePath = path.resolve(source);
        if (!(await pathExists(imagePath))) deps.fail(`Image file not found: ${imagePath}`);
        images.push(await readFile(imagePath));
      }
    }
    const sampleStrength = sampleStrengthRaw ? Number(sampleStrengthRaw) : undefined;
    if (sampleStrengthRaw && !Number.isFinite(sampleStrength)) {
      deps.fail(`Invalid --sample-strength: ${sampleStrengthRaw}`);
    }

    const result = await generateImageComposition(
      model,
      prompt,
      images,
      {
        ratio,
        resolution,
        sampleStrength: sampleStrength as number | undefined,
        negativePrompt,
        intelligentRatio,
        wait,
        waitTimeoutSeconds: parsePositiveNumberOption(args, "wait-timeout-seconds", deps),
        pollIntervalMs: parsePositiveNumberOption(args, "poll-interval-ms", deps),
      },
      pick.token,
      buildRegionInfo(pick.region)
    );
    if (!Array.isArray(result)) {
      if (isJson) deps.printCommandJson("image.edit", result, { wait });
      else deps.printTaskInfo(result);
      return;
    }
    const urls: string[] = result;
    if (urls.length === 0) deps.fail("No image URL found in response.");

    const savedFiles = await downloadImages(urls, outputDir, "jimeng-image-edit", deps);
    if (isJson) {
      deps.printCommandJson(
        "image.edit",
        { data: urls.map((url) => ({ url })), files: savedFiles },
        { wait }
      );
    } else {
      deps.printDownloadSummary("image", savedFiles);
    }
  };

  const handleVideoGenerate = async (argv: string[]): Promise<void> => {
    const usage = deps.usageVideoGenerate();
    const args = minimist(argv, {
      string: [
        "token",
        "region",
        "prompt",
        "mode",
        "image-file",
        "video-file",
        ...VIDEO_OMNI_IMAGE_SLOT_KEYS,
        ...VIDEO_OMNI_VIDEO_SLOT_KEYS,
        "model",
        "ratio",
        "resolution",
        "duration",
        "output-dir",
        "wait-timeout-seconds",
        "poll-interval-ms",
      ],
      boolean: ["help", "wait", "json"],
      default: { wait: true },
    });

    if (args.help) {
      console.log(usage);
      return;
    }

    const token = deps.getSingleString(args, "token");
    const region = deps.getRegionWithDefault(args);
    const prompt = ensurePrompt(deps.getSingleString(args, "prompt"), usage, deps);
    const cliMode = parseVideoCliMode(args, usage, {
      getSingleString: deps.getSingleString,
      toStringList: deps.toStringList,
      failWithUsage: deps.failWithUsage,
    });
    const inputPlan = collectVideoInputPlan(args, usage, {
      getSingleString: deps.getSingleString,
      toStringList: deps.toStringList,
      failWithUsage: deps.failWithUsage,
    });

    const outputDir = deps.getSingleString(args, "output-dir") || "./pic/cli-video-generate";
    const model = deps.getSingleString(args, "model")
      || (cliMode === "omni_reference" ? "jimeng-video-seedance-2.0-fast" : "jimeng-video-3.0");
    validateVideoModeAndModel(cliMode, model, inputPlan, usage, { failWithUsage: deps.failWithUsage });
    const functionMode = cliMode === "omni_reference" ? "omni_reference" : "first_last_frames";
    const ratio = deps.getSingleString(args, "ratio") || "1:1";
    const resolution = deps.getSingleString(args, "resolution") || "720p";
    const durationRaw = deps.getSingleString(args, "duration") || "5";
    const duration = Number(durationRaw);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(duration)) {
      deps.fail(`Invalid --duration: ${durationRaw}. Use a positive integer (seconds).`);
    }
    const wait = Boolean(args.wait);
    const isJson = Boolean(args.json);
    const requiredCapabilityTags = cliMode === "omni_reference" ? ["omni_reference"] : [];
    const pick = await deps.pickDirectTokenForGeneration(token, region, model, "video", requiredCapabilityTags);
    const directInputs = await buildDirectVideoInputPayload(cliMode, inputPlan, {
      isHttpUrl,
      pathExists,
      fail: deps.fail,
    });

    const result = await generateVideo(
      model,
      prompt,
      {
        ratio,
        resolution,
        duration,
        filePaths: directInputs.filePaths,
        files: directInputs.files,
        httpRequest: directInputs.httpRequest,
        functionMode,
        wait,
        waitTimeoutSeconds: parsePositiveNumberOption(args, "wait-timeout-seconds", deps),
        pollIntervalMs: parsePositiveNumberOption(args, "poll-interval-ms", deps),
      },
      pick.token,
      buildRegionInfo(pick.region)
    );

    if (typeof result !== "string") {
      if (isJson) deps.printCommandJson("video.generate", result, { wait, mode: cliMode });
      else deps.printTaskInfo(result);
      return;
    }
    const videoUrl: string = result;

    const { buffer, contentType } = await downloadBinary(videoUrl, deps);
    const dir = path.resolve(outputDir);
    await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const ext = detectVideoExtension(contentType, videoUrl);
    const filePath = path.join(dir, `jimeng-video-generate-${timestamp}.${ext}`);
    await writeFile(filePath, buffer);

    if (isJson) {
      deps.printCommandJson(
        "video.generate",
        { data: [{ url: videoUrl }], files: [filePath] },
        { wait, mode: cliMode }
      );
    } else {
      deps.printDownloadSummary("video", [filePath]);
    }
  };

  const handleImageUpscale = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: [
        "token",
        "region",
        "image",
        "model",
        "resolution",
        "output-dir",
        "wait-timeout-seconds",
        "poll-interval-ms",
      ],
      boolean: ["help", "wait", "json"],
      default: { wait: true },
    });

    if (args.help) {
      console.log(deps.usageImageUpscale());
      return;
    }

    const token = deps.getSingleString(args, "token");
    const region = deps.getRegionWithDefault(args);
    const imageSource = deps.getSingleString(args, "image");
    if (!imageSource) deps.failWithUsage("Missing required --image.", deps.usageImageUpscale());

    const outputDir = deps.getSingleString(args, "output-dir") || "./pic/cli-image-upscale";
    const model = deps.getSingleString(args, "model") || "jimeng-5.0";
    const resolution = deps.getSingleString(args, "resolution") || "4k";
    const wait = Boolean(args.wait);
    const isJson = Boolean(args.json);

    const pick = await deps.pickDirectTokenForGeneration(token, region, model, "image");

    let image: string | Buffer;
    if (isHttpUrl(imageSource)) {
      image = imageSource;
    } else {
      const imagePath = path.resolve(imageSource);
      if (!(await pathExists(imagePath))) deps.fail(`Image file not found: ${imagePath}`);
      image = await readFile(imagePath);
    }

    const result = await upscaleImage(
      model,
      image,
      {
        resolution,
        wait,
        waitTimeoutSeconds: parsePositiveNumberOption(args, "wait-timeout-seconds", deps),
        pollIntervalMs: parsePositiveNumberOption(args, "poll-interval-ms", deps),
      },
      pick.token,
      buildRegionInfo(pick.region)
    );

    if (!Array.isArray(result)) {
      if (isJson) deps.printCommandJson("image.upscale", result, { wait });
      else deps.printTaskInfo(result);
      return;
    }
    const urls: string[] = result;
    if (urls.length === 0) deps.fail("No image URL found in response.");

    const savedFiles = await downloadImages(urls, outputDir, "jimeng-image-upscale", deps);
    if (isJson) {
      deps.printCommandJson(
        "image.upscale",
        { data: urls.map((url) => ({ url })), files: savedFiles },
        { wait, resolution }
      );
    } else {
      deps.printDownloadSummary("image", savedFiles);
    }
  };

  return {
    handleImageGenerate,
    handleImageEdit,
    handleImageUpscale,
    handleVideoGenerate,
  };
}

