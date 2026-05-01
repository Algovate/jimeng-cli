import path from "node:path";

export type VideoCliMode = "text_to_video" | "image_to_video" | "first_last_frames" | "omni_reference";

export const VIDEO_OMNI_IMAGE_SLOT_KEYS = Array.from({ length: 9 }, (_, i) => `image-file-${i + 1}`);
export const VIDEO_OMNI_VIDEO_SLOT_KEYS = Array.from({ length: 3 }, (_, i) => `video-file-${i + 1}`);

const VIDEO_SUPPORTED_MODES: VideoCliMode[] = [
  "text_to_video",
  "image_to_video",
  "first_last_frames",
  "omni_reference",
];

const VIDEO_OMNI_SUPPORTED_MODELS = new Set(["jimeng-video-seedance-2.0", "jimeng-video-seedance-2.0-fast"]);

export type VideoInputPlan = {
  repeatedImageInputs: string[];
  repeatedVideoInputs: string[];
  explicitImageSlots: Array<{ slot: number; input: string }>;
  explicitVideoSlots: Array<{ slot: number; input: string }>;
  totalImageInputs: number;
  totalVideoInputs: number;
};

export type DirectUploadFile = {
  filepath: string;
  originalFilename: string;
};

export type DirectVideoInputPayload = {
  filePaths: string[];
  files: Record<string, DirectUploadFile>;
  httpRequest: { body: Record<string, string> };
};

type ArgMap = Record<string, unknown>;

type ParseDeps = {
  getSingleString: (args: ArgMap, key: string) => string | undefined;
  toStringList: (raw: unknown) => string[];
  failWithUsage: (reason: string, usage: string) => never;
};

type BuildPayloadDeps = {
  isHttpUrl: (input: string) => boolean;
  pathExists: (filePath: string) => Promise<boolean>;
  fail: (message: string) => never;
};

export function parseVideoCliMode(args: ArgMap, usage: string, deps: ParseDeps): VideoCliMode {
  const cliModeRaw = deps.getSingleString(args, "mode") || "text_to_video";
  if (!VIDEO_SUPPORTED_MODES.includes(cliModeRaw as VideoCliMode)) {
    deps.failWithUsage(
      `Invalid --mode: ${cliModeRaw}. Use text_to_video, image_to_video, first_last_frames, or omni_reference.`,
      usage
    );
  }
  return cliModeRaw as VideoCliMode;
}

export function collectVideoInputPlan(args: ArgMap, usage: string, deps: ParseDeps): VideoInputPlan {
  const repeatedImageInputs = deps.toStringList(args["image-file"]);
  const repeatedVideoInputs = deps.toStringList(args["video-file"]);
  const explicitImageSlots = VIDEO_OMNI_IMAGE_SLOT_KEYS
    .map((key, i) => ({ slot: i + 1, input: deps.getSingleString(args, key) }))
    .filter((item): item is { slot: number; input: string } => Boolean(item.input));
  const explicitVideoSlots = VIDEO_OMNI_VIDEO_SLOT_KEYS
    .map((key, i) => ({ slot: i + 1, input: deps.getSingleString(args, key) }))
    .filter((item): item is { slot: number; input: string } => Boolean(item.input));

  if (repeatedImageInputs.length > 0 && explicitImageSlots.length > 0) {
    deps.failWithUsage(
      "Do not mix repeated --image-file with explicit --image-file-N in one command.",
      usage
    );
  }
  if (repeatedVideoInputs.length > 0 && explicitVideoSlots.length > 0) {
    deps.failWithUsage(
      "Do not mix repeated --video-file with explicit --video-file-N in one command.",
      usage
    );
  }

  return {
    repeatedImageInputs,
    repeatedVideoInputs,
    explicitImageSlots,
    explicitVideoSlots,
    totalImageInputs: repeatedImageInputs.length + explicitImageSlots.length,
    totalVideoInputs: repeatedVideoInputs.length + explicitVideoSlots.length,
  };
}

export function validateVideoModeAndModel(
  cliMode: VideoCliMode,
  model: string,
  plan: VideoInputPlan,
  usage: string,
  deps: Pick<ParseDeps, "failWithUsage">
): void {
  if (cliMode === "omni_reference" && !VIDEO_OMNI_SUPPORTED_MODELS.has(model)) {
    deps.failWithUsage(
      `omni_reference mode requires --model jimeng-video-seedance-2.0 or jimeng-video-seedance-2.0-fast (current: ${model}).`,
      usage
    );
  }

  if (cliMode === "text_to_video") {
    if (plan.totalImageInputs + plan.totalVideoInputs > 0) {
      deps.failWithUsage("text_to_video mode does not accept --image-file or --video-file inputs.", usage);
    }
    return;
  }
  if (cliMode === "image_to_video") {
    if (plan.totalVideoInputs > 0) {
      deps.failWithUsage("image_to_video mode does not accept --video-file.", usage);
    }
    if (plan.totalImageInputs !== 1) {
      deps.failWithUsage("image_to_video mode requires exactly one --image-file input.", usage);
    }
    return;
  }
  if (cliMode === "first_last_frames") {
    if (plan.totalVideoInputs > 0) {
      deps.failWithUsage("first_last_frames mode does not accept --video-file.", usage);
    }
    if (plan.totalImageInputs === 0) {
      deps.failWithUsage("first_last_frames mode requires at least one --image-file input.", usage);
    }
    if (plan.totalImageInputs > 2) {
      deps.failWithUsage("first_last_frames mode supports at most 2 image inputs.", usage);
    }
    return;
  }

  if (plan.totalImageInputs + plan.totalVideoInputs === 0) {
    deps.failWithUsage("omni_reference mode requires at least one --image-file or --video-file input.", usage);
  }
  if (plan.totalImageInputs > 9) {
    deps.failWithUsage("omni_reference supports at most 9 image inputs.", usage);
  }
  if (plan.totalVideoInputs > 3) {
    deps.failWithUsage("omni_reference supports at most 3 video inputs.", usage);
  }
}

export async function buildDirectVideoInputPayload(
  cliMode: VideoCliMode,
  plan: VideoInputPlan,
  deps: BuildPayloadDeps
): Promise<DirectVideoInputPayload> {
  const payload: DirectVideoInputPayload = {
    filePaths: [],
    files: {},
    httpRequest: { body: {} },
  };

  const registerInput = async (
    fieldName: string,
    input: string,
    mediaType: "image" | "video"
  ): Promise<void> => {
    if (deps.isHttpUrl(input)) {
      if (cliMode === "omni_reference") {
        payload.httpRequest.body[fieldName] = input;
      } else if (mediaType === "image") {
        payload.filePaths.push(input);
      } else {
        deps.fail(`Mode ${cliMode} does not support video URL input.`);
      }
      return;
    }

    const filePath = path.resolve(input);
    if (!(await deps.pathExists(filePath))) {
      deps.fail(`Input file not found for ${fieldName}: ${filePath}`);
    }
    payload.files[fieldName] = {
      filepath: filePath,
      originalFilename: path.basename(filePath),
    };
  };

  if (cliMode === "omni_reference") {
    for (let i = 0; i < plan.repeatedImageInputs.length; i += 1) {
      await registerInput(`image_file_${i + 1}`, plan.repeatedImageInputs[i], "image");
    }
    for (let i = 0; i < plan.repeatedVideoInputs.length; i += 1) {
      await registerInput(`video_file_${i + 1}`, plan.repeatedVideoInputs[i], "video");
    }
    for (const slot of plan.explicitImageSlots) {
      await registerInput(`image_file_${slot.slot}`, slot.input, "image");
    }
    for (const slot of plan.explicitVideoSlots) {
      await registerInput(`video_file_${slot.slot}`, slot.input, "video");
    }
    return payload;
  }

  const imageInputs =
    plan.repeatedImageInputs.length > 0
      ? plan.repeatedImageInputs
      : plan.explicitImageSlots.sort((a, b) => a.slot - b.slot).map((item) => item.input);
  for (let i = 0; i < imageInputs.length; i += 1) {
    await registerInput(`image_file_${i + 1}`, imageInputs[i], "image");
  }
  return payload;
}

