import process from "node:process";

import config from "@/core/config/config.ts";
import logger from "@/core/utils/logger.ts";
import tokenPool from "@/core/runtime/session-pool.ts";
import {
  parseRegionCode,
  type RegionCode
} from "@/api/services/core.ts";
import {
  createTokenSubcommands,
  type TokenSubcommandDef,
  type TokenSubcommandName
} from "@/cli/commands/token.ts";
import { createQueryCommandHandlers } from "@/cli/commands/query.ts";
import { createMediaCommandHandlers } from "@/cli/commands/media.ts";
import { createLoginCommandHandler } from "@/cli/commands/login.ts";

type JsonRecord = Record<string, unknown>;
type CliHandler = (argv: string[]) => Promise<void>;
type UsageSection = { title: string; lines: string[] };

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
    "  --token <token>          Query with specific token",
    "  --region <region>        Query with specific region (cn/us/hk/jp/sg)",
    "  --all                    Query all tokens in pool, grouped by token/region",
    "  --all-known              Include manual/hidden models known locally",
    "  --verbose                Print rich model fields",
    "  --json                   Print full JSON response",
    HELP_OPTION,
  ], [
    {
      title: "Notes:",
      lines: [
        "  Without --token, --region, or --all, uses the first available token in pool.",
        "  With --all, queries every enabled+live token and groups results by token/region.",
        "  --all-known includes models that are mapped locally but not returned by upstream config.",
      ],
    },
  ]);
}

function usageModelsRefresh(): string {
  return buildUsageText("  jimeng models refresh [options]", [
    "  --json                   Output structured JSON",
    HELP_OPTION,
  ], [
    {
      title: "Notes:",
      lines: [
        "  - Refreshes dynamicCapabilities (imageModels, videoModels, capabilityTags) for",
        "    all enabled+live tokens in the token pool.",
        "  - Results are persisted to token-pool.json automatically.",
      ],
    },
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
    "  --token <token>          Optional, override token-pool selection",
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
    JSON_OPTION,
    "  --output-dir <dir>       Default ./pic/cli-image-generate",
    HELP_OPTION,
  ]);
}

function usageImageEdit(): string {
  return buildUsageText(
    "  jimeng image edit --prompt <text> --image <path_or_url> [--image <path_or_url> ...] [options]",
    [
    "  --token <token>          Optional, override token-pool selection",
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

function usageImageUpscale(): string {
  return buildUsageText(
    "  jimeng image upscale --image <path_or_url> [options]",
    [
    "  --token <token>          Optional, override token-pool selection",
    "  --region <region>        X-Region header, default cn (cn/us/hk/jp/sg)",
    "  --image <path_or_url>    Required, local file or URL",
    "  --model <model>          Default jimeng-5.0",
    "  --resolution <res>       Default 4k (target resolution)",
    "  --wait / --no-wait       Default wait; --no-wait returns task only",
    "  --wait-timeout-seconds   Optional wait timeout override",
    "  --poll-interval-ms       Optional poll interval override",
    JSON_OPTION,
    "  --output-dir <dir>       Default ./pic/cli-image-upscale",
    HELP_OPTION,
    ],
    [
      {
        title: "Notes:",
        lines: [
          "  - Upscales an existing image to higher resolution using super_resolution.",
          "  - Supports 2k and 4k target resolutions.",
          "  - Image source can be a local file path or HTTP URL.",
        ],
      },
    ]
  );
}

function usageVideoGenerate(): string {
  return buildUsageText("  jimeng video generate --prompt <text> [options]", [
    "  --token <token>          Optional, override token-pool selection",
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
    "  --token <token>          Optional, override token-pool selection",
    "  --region <region>        Filter token by region (cn/us/hk/jp/sg)",
    "  --task-id <id>           Required history/task id",
    "  --type <type>            Optional image or video",
    "  --response-format <fmt>  Optional url or b64_json",
    JSON_OPTION,
    HELP_OPTION,
  ]);
}

function usageTaskWait(): string {
  return buildUsageText("  jimeng task wait --task-id <id> [options]", [
    "  --token <token>          Optional, override token-pool selection",
    "  --region <region>        Filter token by region (cn/us/hk/jp/sg)",
    "  --task-id <id>           Required history/task id",
    "  --type <type>            Optional image or video",
    "  --response-format <fmt>  Optional url or b64_json",
    "  --wait-timeout-seconds   Optional wait timeout override",
    "  --poll-interval-ms       Optional poll interval override",
    JSON_OPTION,
    HELP_OPTION,
  ]);
}

function usageTaskList(): string {
  return buildUsageText("  jimeng task list [options]", [
    "  --token <token>          Optional, override token-pool selection",
    "  --region <region>        Filter token by region (cn/us/hk/jp/sg)",
    "  --type <type>            Filter by type: image, video, or all (default all)",
    "  --count <num>            Number of items per page (default 20)",
    JSON_OPTION,
    HELP_OPTION,
  ]);
}

function configureCliLogging(command: string | undefined): void {
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

function unwrapBody(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as JsonRecord;
  if ("data" in body && ("code" in body || "message" in body)) {
    return body.data;
  }
  return payload;
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

function isHelpKeyword(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

const TOKEN_SUBCOMMANDS: TokenSubcommandDef[] = createTokenSubcommands({
  getUsage: (name) => usageTokenSubcommand(name),
  getSingleString,
  getRegionWithDefault,
  toStringList,
  parseRegionOrFail,
  ensureTokenPoolReady,
  fail,
  failWithUsage,
  printJson,
  printCommandJson,
  unwrapBody,
  jsonOption: JSON_OPTION,
  helpOption: HELP_OPTION,
});

const queryHandlers = createQueryCommandHandlers({
  usageModelsList,
  usageModelsRefresh,
  usageTaskGet,
  usageTaskWait,
  usageTaskList,
  getSingleString,
  parseRegionOrFail,
  ensureTokenPoolReady,
  pickDirectTokenForTask,
  fail,
  printJson,
  printCommandJson,
  unwrapBody,
});

const mediaHandlers = createMediaCommandHandlers({
  usageImageGenerate,
  usageImageEdit,
  usageImageUpscale,
  usageVideoGenerate,
  getSingleString,
  getRegionWithDefault,
  toStringList,
  fail,
  failWithUsage,
  pickDirectTokenForGeneration,
  printCommandJson,
  printDownloadSummary,
  printTaskInfo: (task) => queryHandlers.printTaskInfo(task),
});

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
    name: "login",
    description: "Login and add session to token pool",
    handler: createLoginCommandHandler({
      getSingleString,
      getRegionWithDefault,
      parseRegionOrFail,
      ensureTokenPoolReady,
      fail,
      printJson,
      printCommandJson,
    }),
  },
  {
    name: "models",
    description: "Model commands",
    subcommands: [
      { name: "list", description: "List available models", handler: queryHandlers.handleModelsList },
      { name: "refresh", description: "Refresh token dynamic capabilities (model list)", handler: queryHandlers.handleModelsRefresh },
    ],
    usage: usageRoot,
  },
  {
    name: "image",
    description: "Image commands",
    subcommands: [
      { name: "generate", description: "Generate image from text", handler: mediaHandlers.handleImageGenerate },
      { name: "edit", description: "Edit image(s) with prompt", handler: mediaHandlers.handleImageEdit },
      { name: "upscale", description: "Upscale image to higher resolution", handler: mediaHandlers.handleImageUpscale },
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
        handler: mediaHandlers.handleVideoGenerate,
      },
    ],
    usage: usageRoot,
  },
  {
    name: "task",
    description: "Task commands",
    subcommands: [
      { name: "get", description: "Get task status", handler: queryHandlers.handleTaskGet },
      { name: "wait", description: "Wait until task completion", handler: queryHandlers.handleTaskWait },
      { name: "list", description: "List task history", handler: queryHandlers.handleTaskList },
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
    await spec.handler(subcommand ? [subcommand, ...rest] : rest);
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

export function runCli(): void {
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
}
