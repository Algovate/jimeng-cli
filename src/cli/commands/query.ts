import minimist from "minimist";

import { buildRegionInfo, type RegionCode } from "@/api/services/core.ts";
import { getLiveModels, refreshAllTokenModels } from "@/api/services/models.ts";
import { getTaskResponse, waitForTaskResponse, getAssetList, AssetListOptions } from "@/api/services/tasks.ts";
import tokenPool from "@/core/runtime/session-pool.ts";
import { maskToken } from "@/core/utils/util.ts";

type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskInfo = {
  task_id: string;
  type?: string;
  status?: number;
  fail_code?: string | null;
  created?: number;
  data?: unknown;
};

type QueryDeps = {
  usageModelsList: () => string;
  usageModelsRefresh: () => string;
  usageTaskGet: () => string;
  usageTaskWait: () => string;
  usageTaskList: () => string;
  getSingleString: (args: Record<string, unknown>, key: string) => string | undefined;
  parseRegionOrFail: (region: string | undefined) => RegionCode | undefined;
  ensureTokenPoolReady: () => Promise<void>;
  pickDirectTokenForTask: (
    token: string | undefined,
    region: string | undefined
  ) => Promise<{ token: string; region: RegionCode }>;
  fail: (message: string) => never;
  printJson: (value: unknown) => void;
  printCommandJson: (command: string, data: unknown, meta?: JsonRecord) => void;
  unwrapBody: (payload: unknown) => unknown;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseTaskTypeOrFail(value: string | undefined, deps: Pick<QueryDeps, "fail">): "image" | "video" | undefined {
  if (!value) return undefined;
  if (value === "image" || value === "video") return value;
  deps.fail(`Invalid --type: ${value}. Use image or video.`);
}

function parseResponseFormatOrFail(value: string | undefined, deps: Pick<QueryDeps, "fail">): "url" | "b64_json" {
  if (!value) return "url";
  if (value === "url" || value === "b64_json") return value;
  deps.fail(`Invalid --response-format: ${value}. Use url or b64_json.`);
}

function parsePositiveNumberOption(
  args: Record<string, unknown>,
  key: "wait-timeout-seconds" | "poll-interval-ms",
  deps: Pick<QueryDeps, "getSingleString" | "fail">
): number | undefined {
  const raw = deps.getSingleString(args, key);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    deps.fail(`Invalid --${key}: ${raw}`);
  }
  return parsed;
}

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

function collectTaskInfo(payload: unknown, deps: Pick<QueryDeps, "unwrapBody">): TaskInfo | null {
  const normalized = deps.unwrapBody(payload);
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

function printTaskInfo(task: TaskInfo, deps: Pick<QueryDeps, "printJson">): void {
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
    deps.printJson(task.data);
  }
}

/**
 * Common pattern for task.get and task.wait: collect task info, then output.
 */
function outputTaskResult(
  command: string,
  normalized: unknown,
  isJson: boolean,
  deps: QueryDeps
): void {
  const taskInfo = collectTaskInfo(normalized, deps);
  if (!taskInfo) {
    const body = deps.unwrapBody(normalized);
    if (isJson) deps.printCommandJson(command, body);
    else deps.printJson(body);
    return;
  }
  if (isJson) deps.printCommandJson(command, taskInfo);
  else printTaskInfo(taskInfo, deps);
}

/**
 * Resolve token + region for a single model or task query.
 * Prefers explicit --token/--region, falls back to first available pool token.
 */
function resolveSingleQueryToken(
  explicitToken: string | undefined,
  explicitRegion: string | undefined,
  deps: QueryDeps
): { token: string | undefined; region: RegionCode | undefined } {
  const regionCode = explicitRegion ? deps.parseRegionOrFail(explicitRegion) : undefined;

  if (explicitToken) {
    const poolRegion = tokenPool.getTokenEntry(explicitToken)?.region;
    const region = regionCode || poolRegion;
    if (!region) {
      deps.fail("Missing region for token. Provide --region or register token in token-pool.");
    }
    return { token: explicitToken, region };
  }

  if (!regionCode) {
    const entry = tokenPool.getEntries(false).find(
      (item) => item.enabled && item.live !== false && item.region
    );
    if (!entry) {
      deps.fail("No token available. Provide --token, --region, or --all.");
    }
    return { token: entry.token, region: entry.region as RegionCode };
  }

  return { token: undefined, region: regionCode };
}

// ---------------------------------------------------------------------------
// Model display helpers
// ---------------------------------------------------------------------------

function printModelIds(models: unknown[]): void {
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const id = (item as JsonRecord).id;
    if (typeof id === "string" && id.length > 0) console.log(id);
  }
}

function printModelVerbose(models: unknown[]): void {
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const m = item as JsonRecord;
    const id = typeof m.id === "string" ? m.id : "";
    if (!id) continue;
    const type = typeof m.model_type === "string" ? m.model_type : "-";
    const desc = typeof m.description === "string" ? m.description : "-";
    const availability = typeof m.availability === "string" ? m.availability : "discoverable";
    const caps = Array.isArray(m.capabilities)
      ? m.capabilities.filter((c): c is string => typeof c === "string").join(",")
      : "-";
    console.log(`${id}  [${type}]  ${desc}`);
    console.log(`  availability: ${availability}`);
    console.log(`  capabilities: ${caps}`);
    if (Array.isArray(m.requires_entitlement) && m.requires_entitlement.length > 0) {
      console.log(`  requires_entitlement: ${m.requires_entitlement.join(", ")}`);
    }
    const params = m.params;
    if (params && typeof params === "object") {
      for (const [key, vals] of Object.entries(params as Record<string, unknown>)) {
        if (Array.isArray(vals)) {
          console.log(`  ${key}: ${vals.join(", ")}`);
        }
      }
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export function createQueryCommandHandlers(deps: QueryDeps) {
  const handleModelsRefresh = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, { boolean: ["help", "json"] });
    if (args.help) {
      console.log(deps.usageModelsRefresh());
      return;
    }

    await deps.ensureTokenPoolReady();
    const results = await refreshAllTokenModels();
    const isJson = Boolean(args.json);

    if (isJson) {
      deps.printCommandJson("models.refresh", results);
      return;
    }

    if (results.length === 0) {
      console.log("No enabled+live tokens found in pool. Nothing to refresh.");
      return;
    }

    console.log(`Refreshed ${results.length} token(s).`);
    console.log("");
    console.log("token\t\tregion\timageModels\tvideoModels\tcapabilityTags\terror");
    for (const r of results) {
      const tags = r.capabilityTags.length > 0 ? r.capabilityTags.join(",") : "-";
      const err = r.error ? r.error.slice(0, 60) : "-";
      console.log(`${r.token}\t${r.region}\t${r.imageModels}\t\t${r.videoModels}\t\t${tags}\t${err}`);
    }
  };

  const handleModelsList = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: ["region", "token"],
      boolean: ["help", "json", "verbose", "all", "all-known"],
    });
    if (args.help) {
      console.log(deps.usageModelsList());
      return;
    }

    const isJson = Boolean(args.json);
    const isVerbose = Boolean(args.verbose);
    const explicitRegion = deps.getSingleString(args, "region");
    const explicitToken = deps.getSingleString(args, "token");

    const includeManual = Boolean(args["all-known"]);

    await deps.ensureTokenPoolReady();

    // --all: query every enabled+live token with a region
    if (args.all) {
      const entries = tokenPool.getEntries(false).filter(
        (item) => item.enabled && item.live !== false && item.region
      );
      if (entries.length === 0) {
        deps.fail("No enabled+live tokens with region found in pool.");
      }

      const results = await Promise.all(
        entries.map(async (entry): Promise<JsonRecord> => {
          const masked = maskToken(entry.token);
          try {
            const direct = await getLiveModels(`Bearer ${entry.token}`, entry.region, {
              includeManual,
            });
            return {
              token: masked,
              region: entry.region,
              source: direct.source,
              models: isVerbose
                ? direct.data
                : direct.data.map((m: any) => m.id),
            };
          } catch (error: unknown) {
            return { token: masked, region: entry.region, error: error instanceof Error ? error.message : String(error) };
          }
        })
      );

      if (isJson) {
        deps.printCommandJson("models.list", results);
        return;
      }
      for (const r of results) {
        console.log(`[${r.region}] ${r.token}`);
        if (r.error) {
          console.log(`  error: ${r.error}`);
        } else if (isVerbose) {
          printModelVerbose(r.models as unknown[]);
        } else {
          for (const id of r.models as string[]) console.log(`  ${id}`);
        }
        console.log("");
      }
      return;
    }

    // Single query
    const { token, region } = resolveSingleQueryToken(explicitToken, explicitRegion, deps);
    const direct = await getLiveModels(token ? `Bearer ${token}` : undefined, region, {
      includeManual,
    });
    const models = direct.data;

    if (isJson) {
      deps.printCommandJson("models.list", { object: "list", data: models }, {
        region: region || null,
        token: token ? `${token.slice(0, 4)}...` : null,
      });
      return;
    }

    if (models.length === 0) {
      deps.fail("No models found.");
    }

    if (isVerbose) printModelVerbose(models);
    else printModelIds(models);
  };

  const handleTaskGet = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: ["token", "region", "task-id", "type", "response-format"],
      boolean: ["help", "json"],
    });
    if (args.help) {
      console.log(deps.usageTaskGet());
      return;
    }
    const taskId = deps.getSingleString(args, "task-id");
    if (!taskId) deps.fail(`Missing required --task-id.\n\n${deps.usageTaskGet()}`);

    const type = parseTaskTypeOrFail(deps.getSingleString(args, "type"), deps);
    const responseFormat = parseResponseFormatOrFail(deps.getSingleString(args, "response-format"), deps);
    const pick = await deps.pickDirectTokenForTask(deps.getSingleString(args, "token"), deps.getSingleString(args, "region"));
    const normalized = await getTaskResponse(taskId, pick.token, buildRegionInfo(pick.region), { type, responseFormat });
    outputTaskResult("task.get", normalized, Boolean(args.json), deps);
  };

  const handleTaskWait = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: ["token", "region", "task-id", "type", "response-format", "wait-timeout-seconds", "poll-interval-ms"],
      boolean: ["help", "json"],
    });
    if (args.help) {
      console.log(deps.usageTaskWait());
      return;
    }
    const taskId = deps.getSingleString(args, "task-id");
    if (!taskId) deps.fail(`Missing required --task-id.\n\n${deps.usageTaskWait()}`);

    const type = parseTaskTypeOrFail(deps.getSingleString(args, "type"), deps);
    const responseFormat = parseResponseFormatOrFail(deps.getSingleString(args, "response-format"), deps);
    const waitTimeoutSeconds = parsePositiveNumberOption(args, "wait-timeout-seconds", deps);
    const pollIntervalMs = parsePositiveNumberOption(args, "poll-interval-ms", deps);

    const pick = await deps.pickDirectTokenForTask(deps.getSingleString(args, "token"), deps.getSingleString(args, "region"));
    const normalized = await waitForTaskResponse(taskId, pick.token, buildRegionInfo(pick.region), {
      type,
      responseFormat,
      waitTimeoutSeconds,
      pollIntervalMs,
    });
    outputTaskResult("task.wait", normalized, Boolean(args.json), deps);
  };

  const handleTaskList = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: ["token", "region", "type", "count"],
      boolean: ["help", "json"],
    });
    if (args.help) {
      console.log(deps.usageTaskList());
      return;
    }

    const type = deps.getSingleString(args, "type");
    if (type && type !== "image" && type !== "video" && type !== "all") {
      deps.fail(`Invalid --type: ${type}. Use image, video, or all.`);
    }

    const countRaw = deps.getSingleString(args, "count");
    const count = countRaw ? Number(countRaw) : 20;
    const isJson = Boolean(args.json);

    const pick = await deps.pickDirectTokenForTask(deps.getSingleString(args, "token"), deps.getSingleString(args, "region"));
    const result = await getAssetList(pick.token, buildRegionInfo(pick.region), {
      count: Number.isFinite(count) && count > 0 ? count : 20,
      type: type as AssetListOptions["type"],
    });

    if (isJson) {
      deps.printCommandJson("task.list", {
        has_more: result.hasMore,
        next_offset: result.nextOffset,
        total: result.items.length,
        items: result.items,
      });
      return;
    }

    console.log(`Total: ${result.items.length} items${result.hasMore ? " (more available)" : ""}\n`);
    for (const item of result.items) {
      const typeLabel = item.type === 1 ? "IMG" : "VID";
      const statusLabel = item.status === 144 || item.status === 10 ? "DONE" : item.status === 30 ? "FAIL" : "PROC";
      const time = item.createdTime > 0 ? new Date(item.createdTime * 1000).toLocaleString() : "-";
      const modelShort = item.modelName || item.modelReqKey || "-";
      const promptShort = item.prompt.length > 50 ? item.prompt.slice(0, 50) + "..." : item.prompt;
      console.log(`${item.id}  ${typeLabel}  ${statusLabel.padEnd(4)}  ${time}  ${modelShort.padEnd(20)}  ${promptShort}`);
      if (item.imageUrl) console.log(`         ${item.imageUrl}`);
    }
  };

  return {
    handleModelsList,
    handleModelsRefresh,
    handleTaskGet,
    handleTaskWait,
    handleTaskList,
    printTaskInfo: (task: unknown) => {
      const info = collectTaskInfo(task, deps);
      if (!info) { deps.printJson(task); return; }
      printTaskInfo(info, deps);
    },
  };
}
