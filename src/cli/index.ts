#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import minimist from "minimist";
import config from "@/lib/config.ts";
import logger from "@/lib/logger.ts";
import tokenPool from "@/lib/session-pool.ts";
import { buildRegionInfo, parseRegionCode, type RegionCode } from "@/api/controllers/core.ts";
import { getLiveModels } from "@/api/controllers/models.ts";
import { generateImages, generateImageComposition } from "@/api/controllers/images.ts";
import { generateVideo } from "@/api/controllers/videos.ts";
import { getTaskResponse, waitForTaskResponse } from "@/api/controllers/tasks.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:5100";
const DEFAULT_TRANSPORT = "direct";

type JsonRecord = Record<string, unknown>;
type CliHandler = (argv: string[]) => Promise<void>;
type UsageSection = { title: string; lines: string[] };

const BASE_URL_OPTION = "  --base-url <url>         API base URL, default http://127.0.0.1:5100";
const TRANSPORT_OPTION = "  --transport <mode>       direct (default) or server";
const JSON_OPTION = "  --json                   Output structured JSON";
const HELP_OPTION = "  --help                   Show help";

function buildUsageText(
  usageLine: string,
  options: string[],
  sections?: UsageSection[]
): string {
  const lines = [
    "Usage:",
    usageLine,
    "",
    "Options:",
    ...options,
  ];
  if (sections && sections.length > 0) {
    for (const section of sections) {
      lines.push("", section.title, ...section.lines);
    }
  }
  return lines.join("\n");
}

function usageRoot(): string {
  const commandLines = ROOT_COMMAND_ENTRIES.map(
    (entry) => `  ${entry.path.padEnd(32)}${entry.description}`
  );
  return [
    "Usage:",
    "  jimeng <command> [subcommand] [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    ...ROOT_HELP_HINT_LINES,
  ].join("\n");
}

function usageModelsList(): string {
  return buildUsageText("  jimeng models list [options]", [
    "  --base-url <url>         API base URL, default http://127.0.0.1:5100",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --verbose                Print rich model fields",
    "  --json                   Print full JSON response",
    TRANSPORT_OPTION,
    HELP_OPTION,
  ]);
}

function usageTokenSubcommand(name: TokenSubcommandName): string {
  const subcommand = TOKEN_SUBCOMMANDS_BY_NAME[name];
  return buildUsageText(subcommand.usageLine, subcommand.options, subcommand.sections);
}

function usageTokenRoot(): string {
  const subcommandLines = TOKEN_SUBCOMMANDS.map(
    (subcommand) => `  ${subcommand.name.padEnd(24)}${subcommand.description}`
  );
  return [
    "Usage:",
    "  jimeng token <subcommand> [options]",
    "",
    "Subcommands:",
    ...subcommandLines,
    "",
    "Run `jimeng token <subcommand> --help` for details.",
  ].join("\n");
}

function usageImageGenerate(): string {
  return buildUsageText("  jimeng image generate --prompt <text> [options]", [
    "  --token <token>          Optional, override server token-pool",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --prompt <text>          Required",
    "  --model <model>          Default jimeng-4.5",
    "  --ratio <ratio>          Default 1:1",
    "  --resolution <res>       Default 2k",
    "  --negative-prompt <text> Optional",
    "  --sample-strength <num>  Optional, 0-1",
    "  --intelligent-ratio      Optional, enable intelligent ratio",
    "  --wait / --no-wait       Default wait; --no-wait returns task only",
    "  --wait-timeout-seconds   Optional wait timeout override",
    "  --poll-interval-ms       Optional poll interval override",
    BASE_URL_OPTION,
    TRANSPORT_OPTION,
    JSON_OPTION,
    "  --output-dir <dir>       Default ./pic/cli-image-generate",
    HELP_OPTION,
  ]);
}

function usageImageEdit(): string {
  return buildUsageText(
    "  jimeng image edit --prompt <text> --image <path_or_url> [--image <path_or_url> ...] [options]",
    [
    "  --token <token>          Optional, override server token-pool",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --prompt <text>          Required",
    "  --image <path_or_url>    Required, can be repeated (1-10)",
    "  --model <model>          Default jimeng-4.5",
    "  --ratio <ratio>          Default 1:1",
    "  --resolution <res>       Default 2k",
    "  --negative-prompt <text> Optional",
    "  --sample-strength <num>  Optional, 0-1",
    "  --intelligent-ratio      Optional, enable intelligent ratio",
    "  --wait / --no-wait       Default wait; --no-wait returns task only",
    "  --wait-timeout-seconds   Optional wait timeout override",
    "  --poll-interval-ms       Optional poll interval override",
    BASE_URL_OPTION,
    TRANSPORT_OPTION,
    JSON_OPTION,
    "  --output-dir <dir>       Default ./pic/cli-image-edit",
    HELP_OPTION,
    ],
    [
      {
        title: "Notes:",
        lines: ["  - Image sources must be all local files or all URLs in one command."],
      },
    ]
  );
}

function usageVideoGenerate(): string {
  return buildUsageText("  jimeng video generate --prompt <text> [options]", [
    "  --token <token>          Optional, override server token-pool",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --prompt <text>          Required",
    "  --mode <mode>            Optional, text_to_video (default), image_to_video, first_last_frames, or omni_reference",
    "  --image-file <input>     Image input, can be repeated (path or URL)",
    "  --video-file <input>     Video input, can be repeated (path or URL, omni only)",
    "  --image-file-1 <input>   Explicit image slot (1-9) for omni_reference",
    "  --image-file-2 ... -9    More explicit image slots for omni_reference",
    "  --video-file-1 <input>   Explicit video slot (1-3) for omni_reference",
    "  --video-file-2 ... -3    More explicit video slots for omni_reference",
    "  --model <model>          Default jimeng-video-3.0 (jimeng-video-seedance-2.0-fast in omni_reference)",
    "  --ratio <ratio>          Default 1:1",
    "  --resolution <res>       Default 720p",
    "  --duration <seconds>     Default 5",
    "  --wait / --no-wait       Default wait; --no-wait returns task only",
    "  --wait-timeout-seconds   Optional wait timeout override",
    "  --poll-interval-ms       Optional poll interval override",
    BASE_URL_OPTION,
    TRANSPORT_OPTION,
    JSON_OPTION,
    "  --output-dir <dir>       Default ./pic/cli-video-generate",
    HELP_OPTION,
  ], [
    {
      title: "Examples:",
      lines: [
        "  jimeng video generate --mode text_to_video --prompt \"A fox runs in snow\"",
        "  jimeng video generate --mode image_to_video --prompt \"Camera slowly pushes in\" --image-file ./first.png",
        "  jimeng video generate --mode first_last_frames --prompt \"Transition day to night\" --image-file ./first.png --image-file ./last.png",
        "  jimeng video generate --mode omni_reference --model jimeng-video-seedance-2.0-fast --prompt \"Use @image_file_1 for character and @video_file_1 for motion\" --image-file ./character.png --video-file ./motion.mp4",
      ],
    },
    {
      title: "Notes:",
      lines: [
        "  - text_to_video: no image/video input allowed.",
        "  - image_to_video: exactly 1 --image-file input, no --video-file.",
        "  - first_last_frames: 1-2 --image-file inputs, no --video-file.",
        "  - omni_reference: 1-9 images and 0-3 videos (at least one material).",
        "  - omni_reference supports model jimeng-video-seedance-2.0 or jimeng-video-seedance-2.0-fast.",
        "  - Use @image_file_N / @video_file_N in prompt for omni_reference.",
      ],
    },
  ]);
}

function usageTaskGet(): string {
  return buildUsageText("  jimeng task get --task-id <id> [options]", [
    "  --token <token>          Optional, override server token-pool",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --task-id <id>           Required history/task id",
    "  --type <type>            Optional image or video",
    "  --response-format <fmt>  Optional url or b64_json",
    BASE_URL_OPTION,
    TRANSPORT_OPTION,
    JSON_OPTION,
    HELP_OPTION,
  ]);
}

function usageTaskWait(): string {
  return buildUsageText("  jimeng task wait --task-id <id> [options]", [
    "  --token <token>          Optional, override server token-pool",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --task-id <id>           Required history/task id",
    "  --type <type>            Optional image or video",
    "  --response-format <fmt>  Optional url or b64_json",
    "  --wait-timeout-seconds   Optional wait timeout override",
    "  --poll-interval-ms       Optional poll interval override",
    BASE_URL_OPTION,
    TRANSPORT_OPTION,
    JSON_OPTION,
    HELP_OPTION,
  ]);
}

function configureCliLogging(command: string | undefined): void {
  if (command === "serve") return;
  if (process.env.JIMENG_CLI_VERBOSE_LOGS === "true") {
    process.env.JIMENG_CLI_SILENT_LOGS = "false";
    return;
  }
  process.env.JIMENG_CLI_SILENT_LOGS = "true";
  config.system.log_level = "fatal";
  config.system.debug = false;
  config.system.requestLog = false;
  logger.info = () => undefined;
  logger.debug = () => undefined;
  logger.warn = () => undefined;
  logger.error = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;
  console.warn = () => undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function failWithUsage(reason: string, usage: string): never {
  fail(`${reason}\n\n${usage}`);
}

function getSingleString(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return undefined;
}

function getRegionWithDefault(args: Record<string, unknown>): string {
  return getSingleString(args, "region") || "cn";
}

function toStringList(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw
      .flatMap((item) => (typeof item === "string" ? item.split(",") : []))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function sanitizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
}

type TransportMode = "server" | "direct";

function parseTransportMode(args: Record<string, unknown>): TransportMode {
  const raw = (getSingleString(args, "transport") || DEFAULT_TRANSPORT).toLowerCase();
  if (raw === "server" || raw === "direct") return raw;
  fail(`Invalid --transport: ${raw}. Use server or direct.`);
}

let tokenPoolReady = false;
async function ensureTokenPoolReady(): Promise<void> {
  if (tokenPoolReady) return;
  await tokenPool.init();
  tokenPoolReady = true;
}

function parseRegionOrFail(region: string | undefined): RegionCode | undefined {
  if (!region) return undefined;
  const parsed = parseRegionCode(region);
  if (!parsed) fail("Invalid --region. Use cn/us/hk/jp/sg.");
  return parsed;
}

async function pickDirectTokenForGeneration(
  token: string | undefined,
  region: string | undefined,
  requestedModel: string,
  taskType: "image" | "video",
  requiredCapabilityTags: string[] = []
): Promise<{ token: string; region: RegionCode }> {
  await ensureTokenPoolReady();
  const tokenPick = tokenPool.pickTokenForRequest({
    authorization: token ? `Bearer ${token}` : undefined,
    requestedModel,
    taskType,
    requiredCapabilityTags,
    xRegion: region,
  });
  if (!tokenPick.token || !tokenPick.region) {
    fail(tokenPick.reason || "No direct token available. Provide --token and --region, or configure token-pool.");
  }
  return { token: tokenPick.token, region: tokenPick.region };
}

async function pickDirectTokenForTask(
  token: string | undefined,
  region: string | undefined
): Promise<{ token: string; region: RegionCode }> {
  await ensureTokenPoolReady();
  const parsedRegion = parseRegionOrFail(region);

  if (token) {
    const fromPool = tokenPool.getTokenEntry(token)?.region;
    const finalRegion = parsedRegion || fromPool;
    if (!finalRegion) {
      fail("Missing region for direct task mode. Provide --region or register token region in token-pool.");
    }
    return { token, region: finalRegion };
  }

  const candidates = tokenPool
    .getEntries(false)
    .filter((item) => item.enabled && item.live !== false && item.region)
    .filter((item) => (parsedRegion ? item.region === parsedRegion : true));
  if (candidates.length === 0) {
    fail("No token available for direct task mode. Provide --token --region or configure token-pool.");
  }
  return { token: candidates[0].token, region: candidates[0].region! };
}

function maskToken(token: string): string {
  const n = token.length;
  if (n <= 10) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function ensurePrompt(prompt: string | undefined, usage: string): string {
  if (!prompt) {
    fail(`Missing required --prompt.\n\n${usage}`);
  }
  return prompt;
}

function buildAuthHeaders(token: string | undefined): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
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

function detectImageMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function detectVideoUploadMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".m4v":
      return "video/x-m4v";
    default:
      return "application/octet-stream";
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
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return "png";
    }
  }
  if (buffer.length >= 3) {
    // JPEG signature: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpg";
    }
  }
  if (buffer.length >= 12) {
    // WebP signature: RIFF....WEBP
    if (
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "webp";
    }
  }
  if (buffer.length >= 6) {
    const sig = buffer.toString("ascii", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") {
      return "gif";
    }
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

function unwrapBody(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as JsonRecord;
  if ("data" in body && ("code" in body || "message" in body)) {
    return body.data;
  }
  return payload;
}

function assertBusinessSuccess(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const body = payload as JsonRecord;
  if (typeof body.code === "number" && body.code !== 0) {
    const msg = typeof body.message === "string" ? body.message : `Business error: code=${body.code}`;
    fail(msg);
  }
}

async function requestJson(
  endpoint: string,
  init: RequestInit
): Promise<{ payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } };
    const reason = err?.cause?.code || err.message || String(error);
    let hint = "";
    try {
      const url = new URL(endpoint);
      const isLocalServer =
        (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "5100";
      if (isLocalServer) {
        hint =
          "\nHint: local server is unreachable. Start service with `jimeng serve`, or run command with `--transport direct`.";
      }
    } catch {
      // ignore URL parse errors and keep generic message
    }
    fail(`Network request failed: ${reason}${hint}`);
  }
  const text = await response.text();

  let payload: unknown = {};
  try {
    payload = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    fail(`Non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    fail(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  assertBusinessSuccess(payload);
  return { payload };
}

function collectImageUrls(payload: unknown): string[] {
  const normalized = unwrapBody(payload);
  if (normalized && typeof normalized === "object") {
    const data = (normalized as JsonRecord).data;
    if (Array.isArray(data)) {
      return data
        .map((item) => (item && typeof item === "object" ? (item as JsonRecord).url : undefined))
        .filter((url): url is string => typeof url === "string" && url.length > 0);
    }
  }
  return [];
}

function collectVideoUrl(payload: unknown): string | null {
  const normalized = unwrapBody(payload);
  if (!normalized || typeof normalized !== "object") return null;

  const first = Array.isArray((normalized as JsonRecord).data)
    ? ((normalized as JsonRecord).data as unknown[])[0]
    : undefined;
  if (!first || typeof first !== "object") return null;

  const firstObj = first as JsonRecord;
  const direct = firstObj.url;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const nestedVideo = firstObj.video;
  if (nestedVideo && typeof nestedVideo === "object") {
    const nestedUrl = (nestedVideo as JsonRecord).url;
    if (typeof nestedUrl === "string" && nestedUrl.length > 0) return nestedUrl;
  }

  const videoUrl = firstObj.video_url;
  if (typeof videoUrl === "string" && videoUrl.length > 0) return videoUrl;

  const downloadUrl = firstObj.download_url;
  if (typeof downloadUrl === "string" && downloadUrl.length > 0) return downloadUrl;

  return null;
}

type TaskInfo = {
  task_id: string;
  type?: string;
  status?: number;
  fail_code?: string | null;
  created?: number;
  data?: unknown;
};

const TASK_STATUS_TEXT: Record<number, string> = {
  10: "PENDING",
  20: "PROCESSING",
  40: "FAILED",
  50: "COMPLETED",
};

function taskStatusText(status: number): string {
  return TASK_STATUS_TEXT[status] || "UNKNOWN";
}

function formatUnixSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  return `${value} (${new Date(value * 1000).toISOString()})`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printCommandJson(
  command: string,
  data: unknown,
  meta?: JsonRecord
): void {
  const payload: JsonRecord = {
    object: "jimeng_cli_result",
    command,
    data,
  };
  if (meta && Object.keys(meta).length > 0) {
    payload.meta = meta;
  }
  printJson(payload);
}

function printDownloadSummary(kind: "image" | "video", files: string[]): void {
  const label = kind === "image" ? "images" : "video";
  console.log(`Downloaded ${files.length} ${label}.`);
  for (const file of files) {
    console.log(`- ${file}`);
  }
}

function collectTaskInfo(payload: unknown): TaskInfo | null {
  const normalized = unwrapBody(payload);
  if (!normalized || typeof normalized !== "object") return null;
  const obj = normalized as JsonRecord;
  if (typeof obj.task_id !== "string" || obj.task_id.length === 0) return null;
  return {
    task_id: obj.task_id,
    type: typeof obj.type === "string" ? obj.type : undefined,
    status: typeof obj.status === "number" ? obj.status : undefined,
    fail_code: typeof obj.fail_code === "string" || obj.fail_code === null ? (obj.fail_code as string | null) : undefined,
    created: typeof obj.created === "number" ? obj.created : undefined,
    data: obj.data,
  };
}

function printTaskInfo(task: TaskInfo): void {
  console.log(`Task ID: ${task.task_id}`);
  if (task.type) console.log(`Type: ${task.type}`);
  if (typeof task.status === "number") {
    console.log(`Status: ${task.status} (${taskStatusText(task.status)})`);
  }
  if (task.fail_code) console.log(`Fail Code: ${task.fail_code}`);
  if (typeof task.created === "number") {
    console.log(`Created: ${formatUnixSeconds(task.created)}`);
  }
  if (task.data != null) {
    console.log("Data:");
    printJson(task.data);
  }
}

function parsePositiveNumberOption(
  args: Record<string, unknown>,
  key: "wait-timeout-seconds" | "poll-interval-ms"
): number | undefined {
  const raw = getSingleString(args, key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid --${key}: ${raw}`);
  }
  return parsed;
}

function applyWaitOptionsToBody(
  body: JsonRecord,
  args: Record<string, unknown>,
  includeWaitFlag = true
): boolean {
  const wait = Boolean(args.wait);
  if (includeWaitFlag) {
    body.wait = wait;
  }
  const waitTimeoutSeconds = parsePositiveNumberOption(args, "wait-timeout-seconds");
  if (waitTimeoutSeconds !== undefined) {
    body.wait_timeout_seconds = waitTimeoutSeconds;
  }
  const pollIntervalMs = parsePositiveNumberOption(args, "poll-interval-ms");
  if (pollIntervalMs !== undefined) {
    body.poll_interval_ms = pollIntervalMs;
  }
  return wait;
}

function applyWaitOptionsToForm(form: FormData, args: Record<string, unknown>, includeWaitFlag = true): boolean {
  const wait = Boolean(args.wait);
  if (includeWaitFlag) {
    form.append("wait", String(wait));
  }
  const waitTimeoutSeconds = parsePositiveNumberOption(args, "wait-timeout-seconds");
  if (waitTimeoutSeconds !== undefined) {
    form.append("wait_timeout_seconds", String(waitTimeoutSeconds));
  }
  const pollIntervalMs = parsePositiveNumberOption(args, "poll-interval-ms");
  if (pollIntervalMs !== undefined) {
    form.append("poll_interval_ms", String(pollIntervalMs));
  }
  return wait;
}

async function downloadBinary(url: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`Download failed (${response.status}): ${url}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
  };
}

async function downloadImages(urls: string[], outputDir: string, prefix: string): Promise<string[]> {
  const dir = path.resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const saved: string[] = [];

  for (let i = 0; i < urls.length; i += 1) {
    const imageUrl = urls[i];
    const { buffer, contentType } = await downloadBinary(imageUrl);
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

async function readTokensFromFile(filePathArg: string): Promise<string[]> {
  const filePath = path.resolve(filePathArg);
  if (!(await pathExists(filePath))) {
    fail(`Token file not found: ${filePath}`);
  }
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function collectTokensFromArgs(
  args: Record<string, unknown>,
  usage: string,
  required = false
): Promise<string[]> {
  const tokens = [...toStringList(args.token)];
  const tokenFile = getSingleString(args, "token-file");
  if (tokenFile) {
    tokens.push(...(await readTokensFromFile(tokenFile)));
  }
  const deduped = Array.from(new Set(tokens));
  if (required && deduped.length === 0) {
    fail(`No tokens provided.\n\n${usage}`);
  }
  return deduped;
}

function buildAuthorizationForTokens(tokens: string[]): Record<string, string> {
  if (tokens.length === 0) return {};
  return { Authorization: `Bearer ${tokens.join(",")}` };
}

function formatUnixMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toISOString();
}

function printTokenEntriesTable(items: unknown[]): void {
  if (items.length === 0) {
    console.log("(empty)");
    return;
  }
  console.log("token\tregion\tenabled\tlive\tlastCredit\tlastCheckedAt\tfailures");
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as JsonRecord;
    const token = typeof entry.token === "string" ? entry.token : "-";
    const region = typeof entry.region === "string" ? entry.region : "-";
    const enabled = typeof entry.enabled === "boolean" ? String(entry.enabled) : "-";
    const live = typeof entry.live === "boolean" ? String(entry.live) : "-";
    const lastCredit = typeof entry.lastCredit === "number" ? String(entry.lastCredit) : "-";
    const lastCheckedAt = formatUnixMs(entry.lastCheckedAt);
    const failures =
      typeof entry.consecutiveFailures === "number" ? String(entry.consecutiveFailures) : "-";
    console.log(`${token}\t${region}\t${enabled}\t${live}\t${lastCredit}\t${lastCheckedAt}\t${failures}`);
  }
}

async function handleTokenCheck(argv: string[]): Promise<void> {
  const args = minimist(argv, {
    string: ["token", "token-file", "base-url", "region"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand("check");
  if (args.help) {
    console.log(usage);
    return;
  }

  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const region = getRegionWithDefault(args);
  const tokens = await collectTokensFromArgs(args, usage, true);
  if (!args.json) {
    console.log(`Checking ${tokens.length} token(s) against ${baseUrl}/token/check`);
  }

  let invalid = 0;
  let requestErrors = 0;
  const results: Array<{ token_masked: string; live?: boolean; error?: string }> = [];
  for (const token of tokens) {
    const masked = maskToken(token);
    try {
      const { payload } = await requestJson(`${baseUrl}/token/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(region ? { "X-Region": region } : {}),
        },
        body: JSON.stringify({ token, ...(region ? { region } : {}) }),
      });
      const normalized = unwrapBody(payload);
      const live =
        normalized && typeof normalized === "object" ? (normalized as JsonRecord).live : undefined;
      if (live === true) {
        if (!args.json) console.log(`[OK]   ${masked} live=true`);
      } else {
        invalid += 1;
        if (!args.json) console.log(`[FAIL] ${masked} live=false`);
      }
      results.push({ token_masked: masked, live: live === true });
    } catch (error) {
      requestErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (!args.json) console.log(`[ERROR] ${masked} ${message}`);
      results.push({ token_masked: masked, error: message });
    }
  }
  if (args.json) {
    printCommandJson("token.check", results, {
      total: tokens.length,
      invalid,
      request_errors: requestErrors,
    });
  } else {
    console.log(`Summary: total=${tokens.length} invalid=${invalid} request_errors=${requestErrors}`);
  }
  if (requestErrors > 0) process.exit(3);
  if (invalid > 0) process.exit(2);
}

async function handleTokenList(argv: string[]): Promise<void> {
  const args = minimist(argv, {
    string: ["base-url"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand("list");
  if (args.help) {
    console.log(usage);
    return;
  }
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const { payload } = await requestJson(`${baseUrl}/token/pool`, { method: "GET" });
  const normalized = unwrapBody(payload);
  if (args.json) {
    printCommandJson("token.list", normalized);
    return;
  }
  const body = normalized && typeof normalized === "object" ? (normalized as JsonRecord) : {};
  const summary = body.summary;
  if (summary && typeof summary === "object") {
    console.log("Summary:");
    printJson(summary);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  console.log("Entries:");
  printTokenEntriesTable(items);
}

async function handleTokenPointsOrReceive(
  argv: string[],
  action: "points" | "receive"
): Promise<void> {
  const args = minimist(argv, {
    string: ["token", "token-file", "base-url", "region"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand(action);
  if (args.help) {
    console.log(usage);
    return;
  }
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const region = getRegionWithDefault(args);
  const tokens = await collectTokensFromArgs(args, usage, false);
  const { payload } = await requestJson(`${baseUrl}/token/${action}`, {
    method: "POST",
    headers: {
      ...buildAuthorizationForTokens(tokens),
      ...(region ? { "X-Region": region } : {}),
    },
  });
  if (args.json) {
    printCommandJson(`token.${action}`, unwrapBody(payload));
    return;
  }
  printJson(unwrapBody(payload));
}

async function handleTokenAddOrRemove(argv: string[], action: "add" | "remove"): Promise<void> {
  const args = minimist(argv, {
    string: ["token", "token-file", "base-url", "region"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand(action);
  if (args.help) {
    console.log(usage);
    return;
  }
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const region = getRegionWithDefault(args);
  const tokens = await collectTokensFromArgs(args, usage, true);
  const { payload } = await requestJson(`${baseUrl}/token/pool/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens, ...(region ? { region } : {}) }),
  });
  if (args.json) {
    printCommandJson(`token.${action}`, unwrapBody(payload));
    return;
  }
  printJson(unwrapBody(payload));
}

async function handleTokenEnableOrDisable(argv: string[], action: "enable" | "disable"): Promise<void> {
  const args = minimist(argv, {
    string: ["token", "base-url"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand(action);
  if (args.help) {
    console.log(usage);
    return;
  }
  const token = getSingleString(args, "token");
  if (!token) {
    failWithUsage("Missing required --token.", usage);
  }
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const { payload } = await requestJson(`${baseUrl}/token/pool/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (args.json) {
    printCommandJson(`token.${action}`, unwrapBody(payload));
    return;
  }
  printJson(unwrapBody(payload));
}

async function handleTokenPool(argv: string[]): Promise<void> {
  const args = minimist(argv, {
    string: ["base-url"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand("pool");
  if (args.help) {
    console.log(usage);
    return;
  }
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const { payload } = await requestJson(`${baseUrl}/token/pool`, { method: "GET" });
  const normalized = unwrapBody(payload);
  if (args.json) {
    printCommandJson("token.pool", normalized);
    return;
  }
  const body = normalized && typeof normalized === "object" ? (normalized as JsonRecord) : {};
  console.log("Summary:");
  printJson(body.summary ?? {});
  console.log("Entries:");
  printTokenEntriesTable(Array.isArray(body.items) ? body.items : []);
}

async function handleTokenPoolCheckOrReload(
  argv: string[],
  action: "pool-check" | "pool-reload"
): Promise<void> {
  const args = minimist(argv, {
    string: ["base-url"],
    boolean: ["help", "json"],
  });
  const usage = usageTokenSubcommand(action);
  if (args.help) {
    console.log(usage);
    return;
  }
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const endpoint = action === "pool-check" ? "/token/pool/check" : "/token/pool/reload";
  const { payload } = await requestJson(`${baseUrl}${endpoint}`, { method: "POST" });
  if (args.json) {
    printCommandJson(`token.${action}`, unwrapBody(payload));
    return;
  }
  printJson(unwrapBody(payload));
}

async function handleModelsList(argv: string[]): Promise<void> {
  const args = minimist(argv, {
    string: ["base-url", "region", "transport", "token"],
    boolean: ["help", "json", "verbose"],
  });

  if (args.help) {
    console.log(usageModelsList());
    return;
  }

  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const region = getRegionWithDefault(args);
  const transport = parseTransportMode(args);
  const token = getSingleString(args, "token");
  let normalized: unknown;

  if (transport === "direct") {
    await ensureTokenPoolReady();
    const auth = token ? `Bearer ${token}` : undefined;
    const direct = await getLiveModels(auth, region);
    normalized = { object: "list", data: direct.data };
  } else {
    const endpoint = `${baseUrl}/v1/models`;
    const { payload } = await requestJson(endpoint, {
      method: "GET",
      headers: {
        ...(region ? { "X-Region": region } : {}),
      },
    });
    normalized = unwrapBody(payload);
  }

  if (args.json) {
    printCommandJson("models.list", normalized, { transport, region: region || null });
    return;
  }

  const data =
    normalized && typeof normalized === "object" && Array.isArray((normalized as JsonRecord).data)
      ? ((normalized as JsonRecord).data as unknown[])
      : [];

  if (data.length === 0) {
    fail(`No models found in response: ${JSON.stringify(normalized)}`);
  }

  if (args.verbose) {
    console.log("id\ttype\tdesc\tcapabilities");
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const model = item as JsonRecord;
      const id = typeof model.id === "string" ? model.id : "";
      if (!id) continue;
      const modelType = typeof model.model_type === "string" ? model.model_type : "-";
      const description = typeof model.description === "string" ? model.description : "-";
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities.filter((cap): cap is string => typeof cap === "string").join(",")
        : "-";
      console.log(`${id}\ttype=${modelType}\tdesc=${description}\tcapabilities=${capabilities}`);
    }
    return;
  }

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as JsonRecord).id;
    if (typeof id === "string" && id.length > 0) {
      console.log(id);
    }
  }
}

async function handleImageGenerate(argv: string[]): Promise<void> {
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
      "base-url",
      "output-dir",
      "wait-timeout-seconds",
      "poll-interval-ms",
      "transport",
    ],
    boolean: ["help", "intelligent-ratio", "wait", "json"],
    default: { wait: true },
  });

  if (args.help) {
    console.log(usageImageGenerate());
    return;
  }

  const token = getSingleString(args, "token");
  const region = getRegionWithDefault(args);
  const prompt = ensurePrompt(getSingleString(args, "prompt"), usageImageGenerate());
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const transport = parseTransportMode(args);
  const outputDir = getSingleString(args, "output-dir") || "./pic/cli-image-generate";

  const body: JsonRecord = {
    prompt,
    model: getSingleString(args, "model") || "jimeng-4.5",
    ratio: getSingleString(args, "ratio") || "1:1",
    resolution: getSingleString(args, "resolution") || "2k",
  };

  const negativePrompt = getSingleString(args, "negative-prompt");
  if (negativePrompt) body.negative_prompt = negativePrompt;

  if (args["intelligent-ratio"]) {
    body.intelligent_ratio = true;
  }
  const wait = applyWaitOptionsToBody(body, args);
  const isJson = Boolean(args.json);

  const sampleStrengthRaw = getSingleString(args, "sample-strength");
  if (sampleStrengthRaw) {
    const parsed = Number(sampleStrengthRaw);
    if (!Number.isFinite(parsed)) {
      fail(`Invalid --sample-strength: ${sampleStrengthRaw}`);
    }
    body.sample_strength = parsed;
  }

  let urls: string[] = [];
  if (transport === "direct") {
    const pick = await pickDirectTokenForGeneration(
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
      if (isJson) {
        printCommandJson("image.generate", result, { transport, wait });
      }
      else printTaskInfo(result);
      return;
    }
    urls = result;
  } else {
    const endpoint = `${baseUrl}/v1/images/generations`;
    const { payload } = await requestJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(token),
        ...(region ? { "X-Region": region } : {}),
      },
      body: JSON.stringify(body),
    });
    urls = collectImageUrls(payload);
    const taskInfo = collectTaskInfo(payload);
    if (taskInfo && wait === false) {
      if (isJson) {
        printCommandJson("image.generate", taskInfo, { transport, wait });
      }
      else printTaskInfo(taskInfo);
      return;
    }
  }
  if (urls.length === 0) {
    fail("No image URL found in response.");
  }

  const savedFiles = await downloadImages(urls, outputDir, "jimeng-image-generate");
  if (isJson) {
    printCommandJson(
      "image.generate",
      {
        data: urls.map((url) => ({ url })),
        files: savedFiles,
      },
      { transport, wait }
    );
  } else {
    printDownloadSummary("image", savedFiles);
  }
}

async function handleImageEdit(argv: string[]): Promise<void> {
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
      "base-url",
      "output-dir",
      "wait-timeout-seconds",
      "poll-interval-ms",
      "transport",
    ],
    boolean: ["help", "intelligent-ratio", "wait", "json"],
    default: { wait: true },
  });

  if (args.help) {
    console.log(usageImageEdit());
    return;
  }

  const token = getSingleString(args, "token");
  const region = getRegionWithDefault(args);
  const prompt = ensurePrompt(getSingleString(args, "prompt"), usageImageEdit());
  const sources = toStringList(args.image);
  if (sources.length === 0) {
    failWithUsage("Missing required --image.", usageImageEdit());
  }
  if (sources.length > 10) {
    fail("At most 10 images are supported for image edit.");
  }

  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const transport = parseTransportMode(args);
  const outputDir = getSingleString(args, "output-dir") || "./pic/cli-image-edit";
  const model = getSingleString(args, "model") || "jimeng-4.5";
  const ratio = getSingleString(args, "ratio") || "1:1";
  const resolution = getSingleString(args, "resolution") || "2k";
  const negativePrompt = getSingleString(args, "negative-prompt");
  const sampleStrengthRaw = getSingleString(args, "sample-strength");
  const intelligentRatio = Boolean(args["intelligent-ratio"]);
  const wait = Boolean(args.wait);
  const isJson = Boolean(args.json);

  const allUrls = sources.every(isHttpUrl);
  const allLocal = sources.every((item) => !isHttpUrl(item));
  if (!allUrls && !allLocal) {
    fail("Mixed image sources are not supported. Use all URLs or all local files.");
  }

  let urls: string[] = [];
  if (transport === "direct") {
    const pick = await pickDirectTokenForGeneration(token, region, model, "image");
    const images: Array<string | Buffer> = [];
    if (allUrls) {
      images.push(...sources);
    } else {
      for (const source of sources) {
        const imagePath = path.resolve(source);
        if (!(await pathExists(imagePath))) {
          fail(`Image file not found: ${imagePath}`);
        }
        images.push(await readFile(imagePath));
      }
    }
    const sampleStrength = sampleStrengthRaw ? Number(sampleStrengthRaw) : undefined;
    if (sampleStrengthRaw && !Number.isFinite(sampleStrength)) {
      fail(`Invalid --sample-strength: ${sampleStrengthRaw}`);
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
        waitTimeoutSeconds: parsePositiveNumberOption(args, "wait-timeout-seconds"),
        pollIntervalMs: parsePositiveNumberOption(args, "poll-interval-ms"),
      },
      pick.token,
      buildRegionInfo(pick.region)
    );
    if (!Array.isArray(result)) {
      if (isJson) {
        printCommandJson("image.edit", result, { transport, wait });
      }
      else printTaskInfo(result);
      return;
    }
    urls = result;
  } else {
    const endpoint = `${baseUrl}/v1/images/compositions`;

    let payload: unknown = {};
    if (allUrls) {
      const body: JsonRecord = {
        prompt,
        model,
        ratio,
        resolution,
        images: sources,
      };
      if (negativePrompt) body.negative_prompt = negativePrompt;
      if (intelligentRatio) body.intelligent_ratio = true;
      applyWaitOptionsToBody(body, args);
      if (sampleStrengthRaw) {
        const parsed = Number(sampleStrengthRaw);
        if (!Number.isFinite(parsed)) {
          fail(`Invalid --sample-strength: ${sampleStrengthRaw}`);
        }
        body.sample_strength = parsed;
      }

      const result = await requestJson(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(token),
          ...(region ? { "X-Region": region } : {}),
        },
        body: JSON.stringify(body),
      });
      payload = result.payload;
    } else {
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("model", model);
      form.append("ratio", ratio);
      form.append("resolution", resolution);
      if (negativePrompt) form.append("negative_prompt", negativePrompt);
      if (intelligentRatio) form.append("intelligent_ratio", "true");
      applyWaitOptionsToForm(form, args);
      if (sampleStrengthRaw) {
        const parsed = Number(sampleStrengthRaw);
        if (!Number.isFinite(parsed)) {
          fail(`Invalid --sample-strength: ${sampleStrengthRaw}`);
        }
        form.append("sample_strength", String(parsed));
      }

      for (const source of sources) {
        const imagePath = path.resolve(source);
        if (!(await pathExists(imagePath))) {
          fail(`Image file not found: ${imagePath}`);
        }
        const imageBuffer = await readFile(imagePath);
        form.append(
          "images",
          new Blob([imageBuffer], { type: detectImageMime(imagePath) }),
          path.basename(imagePath)
        );
      }

      const result = await requestJson(endpoint, {
        method: "POST",
        headers: {
          ...buildAuthHeaders(token),
          ...(region ? { "X-Region": region } : {}),
        },
        body: form,
      });
      payload = result.payload;
    }

    urls = collectImageUrls(payload);
    const taskInfo = collectTaskInfo(payload);
    if (taskInfo && wait === false) {
      if (isJson) {
        printCommandJson("image.edit", taskInfo, { transport, wait });
      }
      else printTaskInfo(taskInfo);
      return;
    }
  }
  if (urls.length === 0) {
    fail("No image URL found in response.");
  }

  const savedFiles = await downloadImages(urls, outputDir, "jimeng-image-edit");
  if (isJson) {
    printCommandJson(
      "image.edit",
      {
        data: urls.map((url) => ({ url })),
        files: savedFiles,
      },
      { transport, wait }
    );
  } else {
    printDownloadSummary("image", savedFiles);
  }
}

type VideoCliMode = "text_to_video" | "image_to_video" | "first_last_frames" | "omni_reference";

const VIDEO_SUPPORTED_MODES: VideoCliMode[] = [
  "text_to_video",
  "image_to_video",
  "first_last_frames",
  "omni_reference",
];
const VIDEO_OMNI_SUPPORTED_MODELS = new Set(["jimeng-video-seedance-2.0", "jimeng-video-seedance-2.0-fast"]);
const VIDEO_OMNI_IMAGE_SLOT_KEYS = Array.from({ length: 9 }, (_, i) => `image-file-${i + 1}`);
const VIDEO_OMNI_VIDEO_SLOT_KEYS = Array.from({ length: 3 }, (_, i) => `video-file-${i + 1}`);

type VideoInputPlan = {
  repeatedImageInputs: string[];
  repeatedVideoInputs: string[];
  explicitImageSlots: Array<{ slot: number; input: string }>;
  explicitVideoSlots: Array<{ slot: number; input: string }>;
  totalImageInputs: number;
  totalVideoInputs: number;
};

function parseVideoCliMode(args: Record<string, unknown>, usage: string): VideoCliMode {
  const cliModeRaw = getSingleString(args, "mode") || "text_to_video";
  if (!VIDEO_SUPPORTED_MODES.includes(cliModeRaw as VideoCliMode)) {
    failWithUsage(
      `Invalid --mode: ${cliModeRaw}. Use text_to_video, image_to_video, first_last_frames, or omni_reference.`,
      usage
    );
  }
  return cliModeRaw as VideoCliMode;
}

function collectVideoInputPlan(args: Record<string, unknown>, usage: string): VideoInputPlan {
  const repeatedImageInputs = toStringList(args["image-file"]);
  const repeatedVideoInputs = toStringList(args["video-file"]);
  const explicitImageSlots = VIDEO_OMNI_IMAGE_SLOT_KEYS
    .map((key, i) => ({ slot: i + 1, input: getSingleString(args, key) }))
    .filter((item): item is { slot: number; input: string } => Boolean(item.input));
  const explicitVideoSlots = VIDEO_OMNI_VIDEO_SLOT_KEYS
    .map((key, i) => ({ slot: i + 1, input: getSingleString(args, key) }))
    .filter((item): item is { slot: number; input: string } => Boolean(item.input));

  if (repeatedImageInputs.length > 0 && explicitImageSlots.length > 0) {
    failWithUsage(
      "Do not mix repeated --image-file with explicit --image-file-N in one command.",
      usage
    );
  }
  if (repeatedVideoInputs.length > 0 && explicitVideoSlots.length > 0) {
    failWithUsage(
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

function validateVideoModeAndModel(cliMode: VideoCliMode, model: string, plan: VideoInputPlan, usage: string): void {
  if (cliMode === "omni_reference" && !VIDEO_OMNI_SUPPORTED_MODELS.has(model)) {
    failWithUsage(
      `omni_reference mode requires --model jimeng-video-seedance-2.0 or jimeng-video-seedance-2.0-fast (current: ${model}).`,
      usage
    );
  }

  if (cliMode === "text_to_video") {
    if (plan.totalImageInputs + plan.totalVideoInputs > 0) {
      failWithUsage("text_to_video mode does not accept --image-file or --video-file inputs.", usage);
    }
    return;
  }
  if (cliMode === "image_to_video") {
    if (plan.totalVideoInputs > 0) {
      failWithUsage("image_to_video mode does not accept --video-file.", usage);
    }
    if (plan.totalImageInputs !== 1) {
      failWithUsage("image_to_video mode requires exactly one --image-file input.", usage);
    }
    return;
  }
  if (cliMode === "first_last_frames") {
    if (plan.totalVideoInputs > 0) {
      failWithUsage("first_last_frames mode does not accept --video-file.", usage);
    }
    if (plan.totalImageInputs === 0) {
      failWithUsage("first_last_frames mode requires at least one --image-file input.", usage);
    }
    if (plan.totalImageInputs > 2) {
      failWithUsage("first_last_frames mode supports at most 2 image inputs.", usage);
    }
    return;
  }

  if (plan.totalImageInputs + plan.totalVideoInputs === 0) {
    failWithUsage("omni_reference mode requires at least one --image-file or --video-file input.", usage);
  }
  if (plan.totalImageInputs > 9) {
    failWithUsage("omni_reference supports at most 9 image inputs.", usage);
  }
  if (plan.totalVideoInputs > 3) {
    failWithUsage("omni_reference supports at most 3 video inputs.", usage);
  }
}

async function appendVideoInput(
  form: FormData,
  fieldName: string,
  input: string,
  mediaType: "image" | "video"
): Promise<void> {
  if (isHttpUrl(input)) {
    form.append(fieldName, input);
    return;
  }
  const filePath = path.resolve(input);
  if (!(await pathExists(filePath))) {
    fail(`Input file not found for ${fieldName}: ${filePath}`);
  }
  const buffer = await readFile(filePath);
  const mime = mediaType === "image" ? detectImageMime(filePath) : detectVideoUploadMime(filePath);
  form.append(fieldName, new Blob([buffer], { type: mime }), path.basename(filePath));
}

async function appendVideoInputs(form: FormData, plan: VideoInputPlan): Promise<void> {
  for (let i = 0; i < plan.repeatedImageInputs.length; i += 1) {
    await appendVideoInput(form, `image_file_${i + 1}`, plan.repeatedImageInputs[i], "image");
  }
  for (let i = 0; i < plan.repeatedVideoInputs.length; i += 1) {
    await appendVideoInput(form, `video_file_${i + 1}`, plan.repeatedVideoInputs[i], "video");
  }
  for (const slot of plan.explicitImageSlots) {
    await appendVideoInput(form, `image_file_${slot.slot}`, slot.input, "image");
  }
  for (const slot of plan.explicitVideoSlots) {
    await appendVideoInput(form, `video_file_${slot.slot}`, slot.input, "video");
  }
}

type DirectUploadFile = {
  filepath: string;
  originalFilename: string;
};

type DirectVideoInputPayload = {
  filePaths: string[];
  files: Record<string, DirectUploadFile>;
  httpRequest: { body: Record<string, string> };
};

async function buildDirectVideoInputPayload(
  cliMode: VideoCliMode,
  plan: VideoInputPlan
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
    if (isHttpUrl(input)) {
      if (cliMode === "omni_reference") {
        payload.httpRequest.body[fieldName] = input;
      } else if (mediaType === "image") {
        payload.filePaths.push(input);
      } else {
        fail(`Mode ${cliMode} does not support video URL input.`);
      }
      return;
    }

    const filePath = path.resolve(input);
    if (!(await pathExists(filePath))) {
      fail(`Input file not found for ${fieldName}: ${filePath}`);
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

async function handleVideoGenerate(argv: string[]): Promise<void> {
  const usage = usageVideoGenerate();
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
      "base-url",
      "output-dir",
      "wait-timeout-seconds",
      "poll-interval-ms",
      "transport",
    ],
    boolean: ["help", "wait", "json"],
    default: { wait: true },
  });

  if (args.help) {
    console.log(usage);
    return;
  }

  const token = getSingleString(args, "token");
  const region = getRegionWithDefault(args);
  const prompt = ensurePrompt(getSingleString(args, "prompt"), usage);
  const cliMode = parseVideoCliMode(args, usage);
  const inputPlan = collectVideoInputPlan(args, usage);
  const transport = parseTransportMode(args);

  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const outputDir = getSingleString(args, "output-dir") || "./pic/cli-video-generate";
  const model = getSingleString(args, "model")
    || (cliMode === "omni_reference" ? "jimeng-video-seedance-2.0-fast" : "jimeng-video-3.0");
  validateVideoModeAndModel(cliMode, model, inputPlan, usage);
  const functionMode = cliMode === "omni_reference" ? "omni_reference" : "first_last_frames";
  const ratio = getSingleString(args, "ratio") || "1:1";
  const resolution = getSingleString(args, "resolution") || "720p";
  const duration = getSingleString(args, "duration") || "5";
  const wait = Boolean(args.wait);
  const isJson = Boolean(args.json);
  let videoUrl: string | null = null;

  if (transport === "direct") {
    const requiredCapabilityTags = cliMode === "omni_reference" ? ["omni_reference"] : [];
    const pick = await pickDirectTokenForGeneration(token, region, model, "video", requiredCapabilityTags);
    const directInputs = await buildDirectVideoInputPayload(cliMode, inputPlan);
    const result = await generateVideo(
      model,
      prompt,
      {
        ratio,
        resolution,
        duration: Number(duration),
        filePaths: directInputs.filePaths,
        files: directInputs.files,
        httpRequest: directInputs.httpRequest,
        functionMode,
        wait,
        waitTimeoutSeconds: parsePositiveNumberOption(args, "wait-timeout-seconds"),
        pollIntervalMs: parsePositiveNumberOption(args, "poll-interval-ms"),
      },
      pick.token,
      buildRegionInfo(pick.region)
    );

    if (typeof result !== "string") {
      if (isJson) {
        printCommandJson("video.generate", result, { transport, wait, mode: cliMode });
      }
      else printTaskInfo(result);
      return;
    }
    videoUrl = result;
  } else {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("model", model);
    form.append("functionMode", functionMode);
    form.append("ratio", ratio);
    form.append("resolution", resolution);
    form.append("duration", duration);
    applyWaitOptionsToForm(form, args);
    await appendVideoInputs(form, inputPlan);

    const endpoint = `${baseUrl}/v1/videos/generations`;
    const { payload } = await requestJson(endpoint, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(token),
        ...(region ? { "X-Region": region } : {}),
      },
      body: form,
    });

    videoUrl = collectVideoUrl(payload);
    const taskInfo = collectTaskInfo(payload);
    if (taskInfo && wait === false) {
      if (isJson) {
        printCommandJson("video.generate", taskInfo, { transport, wait, mode: cliMode });
      }
      else printTaskInfo(taskInfo);
      return;
    }
    if (!videoUrl) {
      fail(`No video URL found in response: ${JSON.stringify(payload)}`);
    }
  }

  const { buffer, contentType } = await downloadBinary(videoUrl);
  const dir = path.resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const ext = detectVideoExtension(contentType, videoUrl);
  const filePath = path.join(dir, `jimeng-video-generate-${timestamp}.${ext}`);
  await writeFile(filePath, buffer);

  if (isJson) {
    printCommandJson(
      "video.generate",
      {
        data: [{ url: videoUrl }],
        files: [filePath],
      },
      { transport, wait, mode: cliMode }
    );
  } else {
    printDownloadSummary("video", [filePath]);
  }
}

async function handleTaskGet(argv: string[]): Promise<void> {
  const args = minimist(argv, {
    string: ["token", "region", "task-id", "type", "response-format", "base-url", "transport"],
    boolean: ["help", "json"],
  });
  if (args.help) {
    console.log(usageTaskGet());
    return;
  }
  const taskId = getSingleString(args, "task-id");
  if (!taskId) fail(`Missing required --task-id.\n\n${usageTaskGet()}`);
  const type = getSingleString(args, "type");
  const responseFormat = getSingleString(args, "response-format");
  const token = getSingleString(args, "token");
  const region = getRegionWithDefault(args);
  const transport = parseTransportMode(args);
  const isJson = Boolean(args.json);
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  let normalized: unknown;

  if (transport === "direct") {
    const pick = await pickDirectTokenForTask(token, region);
    normalized = await getTaskResponse(
      taskId,
      pick.token,
      buildRegionInfo(pick.region),
      {
        type: type === "image" || type === "video" ? type : undefined,
        responseFormat: responseFormat === "b64_json" ? "b64_json" : "url",
      }
    );
  } else {
    const query = new URLSearchParams();
    if (type) query.set("type", type);
    if (responseFormat) query.set("response_format", responseFormat);
    const endpoint = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}${query.toString() ? `?${query.toString()}` : ""}`;
    const { payload } = await requestJson(endpoint, {
      method: "GET",
      headers: {
        ...buildAuthHeaders(token),
        ...(region ? { "X-Region": region } : {}),
      },
    });
    normalized = payload;
  }
  const taskInfo = collectTaskInfo(normalized);
  if (!taskInfo) {
    if (isJson) {
      printCommandJson("task.get", unwrapBody(normalized), { transport });
    } else {
      printJson(unwrapBody(normalized));
    }
    return;
  }
  if (isJson) printCommandJson("task.get", taskInfo, { transport });
  else printTaskInfo(taskInfo);
}

async function handleTaskWait(argv: string[]): Promise<void> {
  const args = minimist(argv, {
    string: [
      "token",
      "region",
      "task-id",
      "type",
      "response-format",
      "wait-timeout-seconds",
      "poll-interval-ms",
      "base-url",
      "transport",
    ],
    boolean: ["help", "json"],
  });
  if (args.help) {
    console.log(usageTaskWait());
    return;
  }
  const taskId = getSingleString(args, "task-id");
  if (!taskId) fail(`Missing required --task-id.\n\n${usageTaskWait()}`);
  const token = getSingleString(args, "token");
  const region = getRegionWithDefault(args);
  const transport = parseTransportMode(args);
  const isJson = Boolean(args.json);
  const baseUrl = sanitizeBaseUrl(getSingleString(args, "base-url"));
  const body: JsonRecord = {};
  const type = getSingleString(args, "type");
  const responseFormat = getSingleString(args, "response-format");
  if (type) body.type = type;
  if (responseFormat) body.response_format = responseFormat;
  applyWaitOptionsToBody(body, args, false);

  let normalized: unknown;
  if (transport === "direct") {
    const pick = await pickDirectTokenForTask(token, region);
    normalized = await waitForTaskResponse(
      taskId,
      pick.token,
      buildRegionInfo(pick.region),
      {
        type: type === "image" || type === "video" ? type : undefined,
        responseFormat: responseFormat === "b64_json" ? "b64_json" : "url",
        waitTimeoutSeconds: typeof body.wait_timeout_seconds === "number" ? body.wait_timeout_seconds : undefined,
        pollIntervalMs: typeof body.poll_interval_ms === "number" ? body.poll_interval_ms : undefined,
      }
    );
  } else {
    const endpoint = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/wait`;
    const { payload } = await requestJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(token),
        ...(region ? { "X-Region": region } : {}),
      },
      body: JSON.stringify(body),
    });
    normalized = payload;
  }

  const taskInfo = collectTaskInfo(normalized);
  if (!taskInfo) {
    if (isJson) {
      printCommandJson("task.wait", unwrapBody(normalized), { transport });
    } else {
      printJson(unwrapBody(normalized));
    }
    return;
  }
  if (isJson) printCommandJson("task.wait", taskInfo, { transport });
  else printTaskInfo(taskInfo);
}

function isHelpKeyword(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

type TokenSubcommandDef = {
  name: TokenSubcommandName;
  description: string;
  usageLine: string;
  options: string[];
  sections?: UsageSection[];
  handler: CliHandler;
};

type TokenSubcommandName =
  | "list"
  | "check"
  | "points"
  | "receive"
  | "add"
  | "remove"
  | "enable"
  | "disable"
  | "pool"
  | "pool-check"
  | "pool-reload";

const TOKEN_SUBCOMMANDS: TokenSubcommandDef[] = [
  {
    name: "list",
    description: "List token pool entries",
    usageLine: "  jimeng token list [options]",
    options: [JSON_OPTION, BASE_URL_OPTION, HELP_OPTION],
    handler: handleTokenList,
  },
  {
    name: "check",
    description: "Validate tokens via /token/check",
    usageLine: "  jimeng token check --token <token> [--token <token> ...] [options]",
    options: [
      "  --token <token>          Token, can be repeated",
      "  --token-file <path>      Read tokens from file (one per line, # for comments)",
      "  --region <region>        X-Region, default cn (cn/us/hk/jp/sg)",
      JSON_OPTION,
      BASE_URL_OPTION,
      HELP_OPTION,
    ],
    handler: handleTokenCheck,
  },
  {
    name: "points",
    description: "Query token points (fallback to server token-pool)",
    usageLine: "  jimeng token points [options]",
    options: [
      "  --token <token>          Token, can be repeated",
      "  --token-file <path>      Read tokens from file (one per line, # for comments)",
      "  --region <region>        Filter tokens by X-Region, default cn (cn/us/hk/jp/sg)",
      JSON_OPTION,
      BASE_URL_OPTION,
      HELP_OPTION,
    ],
    handler: async (argv) => handleTokenPointsOrReceive(argv, "points"),
  },
  {
    name: "receive",
    description: "Receive token credits (fallback to server token-pool)",
    usageLine: "  jimeng token receive [options]",
    options: [
      "  --token <token>          Token, can be repeated",
      "  --token-file <path>      Read tokens from file (one per line, # for comments)",
      "  --region <region>        Filter tokens by X-Region, default cn (cn/us/hk/jp/sg)",
      JSON_OPTION,
      BASE_URL_OPTION,
      HELP_OPTION,
    ],
    handler: async (argv) => handleTokenPointsOrReceive(argv, "receive"),
  },
  {
    name: "add",
    description: "Add token(s) into token-pool",
    usageLine: "  jimeng token add --token <token> [--token <token> ...] [options]",
    options: [
      "  --token <token>          Token, can be repeated",
      "  --token-file <path>      Read tokens from file (one per line, # for comments)",
      "  --region <region>        Region for add, default cn (cn/us/hk/jp/sg)",
      JSON_OPTION,
      BASE_URL_OPTION,
      HELP_OPTION,
    ],
    handler: async (argv) => handleTokenAddOrRemove(argv, "add"),
  },
  {
    name: "remove",
    description: "Remove token(s) from token-pool",
    usageLine: "  jimeng token remove --token <token> [--token <token> ...] [options]",
    options: [
      "  --token <token>          Token, can be repeated",
      "  --token-file <path>      Read tokens from file (one per line, # for comments)",
      JSON_OPTION,
      BASE_URL_OPTION,
      HELP_OPTION,
    ],
    handler: async (argv) => handleTokenAddOrRemove(argv, "remove"),
  },
  {
    name: "enable",
    description: "Enable one token in token-pool",
    usageLine: "  jimeng token enable --token <token> [options]",
    options: ["  --token <token>          Required, a single token", JSON_OPTION, BASE_URL_OPTION, HELP_OPTION],
    handler: async (argv) => handleTokenEnableOrDisable(argv, "enable"),
  },
  {
    name: "disable",
    description: "Disable one token in token-pool",
    usageLine: "  jimeng token disable --token <token> [options]",
    options: ["  --token <token>          Required, a single token", JSON_OPTION, BASE_URL_OPTION, HELP_OPTION],
    handler: async (argv) => handleTokenEnableOrDisable(argv, "disable"),
  },
  {
    name: "pool",
    description: "Show token-pool summary and entries",
    usageLine: "  jimeng token pool [options]",
    options: [JSON_OPTION, BASE_URL_OPTION, HELP_OPTION],
    handler: handleTokenPool,
  },
  {
    name: "pool-check",
    description: "Trigger token-pool health check",
    usageLine: "  jimeng token pool-check [options]",
    options: [JSON_OPTION, BASE_URL_OPTION, HELP_OPTION],
    handler: async (argv) => handleTokenPoolCheckOrReload(argv, "pool-check"),
  },
  {
    name: "pool-reload",
    description: "Reload token-pool from disk",
    usageLine: "  jimeng token pool-reload [options]",
    options: [JSON_OPTION, BASE_URL_OPTION, HELP_OPTION],
    handler: async (argv) => handleTokenPoolCheckOrReload(argv, "pool-reload"),
  },
];

const TOKEN_SUBCOMMANDS_BY_NAME: Record<TokenSubcommandName, TokenSubcommandDef> = Object.fromEntries(
  TOKEN_SUBCOMMANDS.map((subcommand) => [subcommand.name, subcommand])
) as Record<TokenSubcommandName, TokenSubcommandDef>;

function buildHandlersMap(
  subcommands: Array<{ name: string; handler: CliHandler }>
): Record<string, CliHandler> {
  return Object.fromEntries(subcommands.map((item) => [item.name, item.handler]));
}

type CommandSubcommandDef = {
  name: string;
  description: string;
  handler: CliHandler;
};

type CommandSpec = {
  name: string;
  description: string;
  handler?: CliHandler;
  subcommands?: CommandSubcommandDef[];
  usage?: () => string;
  showAsGrouped?: boolean;
};

const COMMAND_SPECS: CommandSpec[] = [
  {
    name: "serve",
    description: "Start jimeng-cli service",
    handler: async () => {
      const { startService } = await import("../lib/start-service.ts");
      await startService();
    },
  },
  {
    name: "models",
    description: "Model commands",
    subcommands: [{ name: "list", description: "List available models", handler: handleModelsList }],
    usage: usageRoot,
  },
  {
    name: "image",
    description: "Image commands",
    subcommands: [
      { name: "generate", description: "Generate image from text", handler: handleImageGenerate },
      { name: "edit", description: "Edit image(s) with prompt", handler: handleImageEdit },
    ],
    usage: usageRoot,
  },
  {
    name: "video",
    description: "Video commands",
    subcommands: [
      {
        name: "generate",
        description: "Generate video from multimodal references",
        handler: handleVideoGenerate,
      },
    ],
    usage: usageRoot,
  },
  {
    name: "task",
    description: "Task commands",
    subcommands: [
      { name: "get", description: "Get task status", handler: handleTaskGet },
      { name: "wait", description: "Wait until task completion", handler: handleTaskWait },
    ],
    usage: usageRoot,
  },
  {
    name: "token",
    description: "Token management commands",
    subcommands: TOKEN_SUBCOMMANDS.map((subcommand) => ({
      name: subcommand.name,
      description: subcommand.description,
      handler: subcommand.handler,
    })),
    usage: usageTokenRoot,
    showAsGrouped: true,
  },
];

const COMMAND_SPECS_BY_NAME: Record<string, CommandSpec> = Object.fromEntries(
  COMMAND_SPECS.map((spec) => [spec.name, spec])
);

const ROOT_COMMAND_ENTRIES: Array<{ path: string; description: string }> = COMMAND_SPECS.flatMap((spec) => {
  if (spec.handler) {
    return [{ path: spec.name, description: spec.description }];
  }
  if (!spec.subcommands || spec.subcommands.length === 0) {
    return [{ path: spec.name, description: spec.description }];
  }
  if (spec.showAsGrouped) {
    return [{ path: `${spec.name} <subcommand>`, description: spec.description }];
  }
  return spec.subcommands.map((subcommand) => ({
    path: `${spec.name} ${subcommand.name}`,
    description: subcommand.description,
  }));
});

const ROOT_HELP_HINT_LINES: string[] = [
  "Run `jimeng <command> --help` for command details.",
  ...COMMAND_SPECS
    .filter((spec) => spec.showAsGrouped)
    .map((spec) => `Run \`jimeng ${spec.name} --help\` for ${spec.name} subcommands.`),
];

async function dispatchSubcommand(
  subcommand: string | undefined,
  argv: string[],
  handlers: Record<string, CliHandler>,
  usage: string,
  unknownLabel: string
): Promise<boolean> {
  if (!subcommand || isHelpKeyword(subcommand)) {
    console.log(usage);
    return true;
  }
  const handler = handlers[subcommand];
  if (!handler) {
    failWithUsage(`Unknown ${unknownLabel}: ${subcommand}`, usage);
  }
  await handler(argv);
  return true;
}

async function run(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  configureCliLogging(command);

  if (!command || isHelpKeyword(command)) {
    console.log(usageRoot());
    return;
  }
  const spec = COMMAND_SPECS_BY_NAME[command];
  if (!spec) {
    failWithUsage(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`, usageRoot());
  }

  if (spec.handler) {
    await spec.handler(rest);
    return;
  }

  if (spec.subcommands) {
    const handlers = buildHandlersMap(spec.subcommands);
    if (
      await dispatchSubcommand(
        subcommand,
        process.argv.slice(3),
        handlers,
        spec.usage ? spec.usage() : usageRoot(),
        `${command} subcommand`
      )
    ) {
      return;
    }
  }

  failWithUsage(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`, usageRoot());
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const isJson = process.argv.includes("--json");
  if (isJson) {
    printCommandJson("error", { message });
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
});
