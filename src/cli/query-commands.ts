import minimist from "minimist";

import { buildRegionInfo, type RegionCode } from "@/api/controllers/core.ts";
import { getLiveModels, refreshAllTokenModels } from "@/api/controllers/models.ts";
import { getTaskResponse, waitForTaskResponse, getAssetList, AssetListOptions } from "@/api/controllers/tasks.ts";
import tokenPool from "@/lib/session-pool.ts";

type JsonRecord = Record<string, unknown>;

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
  getRegionWithDefault: (args: Record<string, unknown>) => string;
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

function parseTaskTypeOrFail(value: string | undefined, deps: Pick<QueryDeps, "fail">): "image" | "video" | undefined {
  if (!value) return undefined;
  if (value === "image" || value === "video") return value;
  deps.fail(`Invalid --type: ${value}. Use image or video.`);
}

function parseResponseFormatOrFail(
  value: string | undefined,
  deps: Pick<QueryDeps, "fail">
): "url" | "b64_json" {
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

export function createQueryCommandHandlers(deps: QueryDeps): {
  handleModelsList: (argv: string[]) => Promise<void>;
  handleModelsRefresh: (argv: string[]) => Promise<void>;
  handleTaskGet: (argv: string[]) => Promise<void>;
  handleTaskWait: (argv: string[]) => Promise<void>;
  handleTaskList: (argv: string[]) => Promise<void>;
  printTaskInfo: (task: unknown) => void;
} {
  const handleModelsRefresh = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      boolean: ["help", "json"],
    });

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
      boolean: ["help", "json", "verbose", "all"],
    });

    if (args.help) {
      console.log(deps.usageModelsList());
      return;
    }

    const isJson = Boolean(args.json);
    const isVerbose = Boolean(args.verbose);
    const isAll = Boolean(args.all);
    const explicitRegion = deps.getSingleString(args, "region");
    const explicitToken = deps.getSingleString(args, "token");

    await deps.ensureTokenPoolReady();

    // --all: query every enabled+live token with a region
    if (isAll) {
      const entries = tokenPool.getEntries(false).filter(
        (item) => item.enabled && item.live !== false && item.region
      );
      if (entries.length === 0) {
        deps.fail("No enabled+live tokens with region found in pool.");
      }
      const results: JsonRecord[] = [];
      for (const entry of entries) {
        const masked = entry.token.length > 10
          ? `${entry.token.slice(0, 4)}...${entry.token.slice(-4)}`
          : "***";
        try {
          const direct = await getLiveModels(`Bearer ${entry.token}`, entry.region);
          results.push({
            token: masked,
            region: entry.region,
            models: direct.data.map((m: any) => m.id),
          });
        } catch (error: any) {
          results.push({
            token: masked,
            region: entry.region,
            error: error.message,
          });
        }
      }
      if (isJson) {
        deps.printCommandJson("models.list", results);
        return;
      }
      for (const r of results) {
        console.log(`[${r.region}] ${r.token}`);
        if (r.error) {
          console.log(`  error: ${r.error}`);
        } else {
          for (const id of r.models as string[]) {
            console.log(`  ${id}`);
          }
        }
        console.log("");
      }
      return;
    }

    // Single query: --token and/or --region
    const regionCode = explicitRegion ? deps.parseRegionOrFail(explicitRegion) : undefined;
    const auth = explicitToken ? `Bearer ${explicitToken}` : undefined;

    if (!auth && !regionCode) {
      // No explicit token/region — pick first available token from pool
      const poolEntry = tokenPool.getEntries(false).find(
        (item) => item.enabled && item.live !== false && item.region
      );
      if (!poolEntry) {
        deps.fail("No token available. Provide --token, --region, or --all.");
      }
      var pickedToken = poolEntry.token;
      var pickedRegion = poolEntry.region as RegionCode;
    } else {
      // Resolve token from pool if --token given but no explicit region
      if (explicitToken && !regionCode) {
        const poolEntry = tokenPool.getTokenEntry(explicitToken);
        if (poolEntry?.region) {
          var pickedRegion = poolEntry.region as RegionCode;
        } else {
          deps.fail("Missing region for token. Provide --region or register token in token-pool.");
        }
        var pickedToken = explicitToken;
      } else {
        var pickedToken = explicitToken;
        var pickedRegion = regionCode!;
      }
    }

    const direct = await getLiveModels(pickedToken ? `Bearer ${pickedToken}` : undefined, pickedRegion);
    const normalized: unknown = { object: "list", data: direct.data };

    if (isJson) {
      deps.printCommandJson("models.list", normalized, { region: pickedRegion || null, token: pickedToken ? `${pickedToken.slice(0, 4)}...` : null });
      return;
    }

    const data =
      normalized && typeof normalized === "object" && Array.isArray((normalized as JsonRecord).data)
        ? ((normalized as JsonRecord).data as unknown[])
        : [];

    if (data.length === 0) {
      deps.fail(`No models found in response: ${JSON.stringify(normalized)}`);
    }

    if (isVerbose) {
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
    const token = deps.getSingleString(args, "token");
    const region = deps.getSingleString(args, "region");
    const isJson = Boolean(args.json);
    const pick = await deps.pickDirectTokenForTask(token, region);
    const normalized: unknown = await getTaskResponse(
      taskId,
      pick.token,
      buildRegionInfo(pick.region),
      {
        type,
        responseFormat,
      }
    );
    const taskInfo = collectTaskInfo(normalized, deps);
    if (!taskInfo) {
      if (isJson) {
        deps.printCommandJson("task.get", deps.unwrapBody(normalized));
      } else {
        deps.printJson(deps.unwrapBody(normalized));
      }
      return;
    }
    if (isJson) deps.printCommandJson("task.get", taskInfo);
    else printTaskInfo(taskInfo, deps);
  };

  const handleTaskWait = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: [
        "token",
        "region",
        "task-id",
        "type",
        "response-format",
        "wait-timeout-seconds",
        "poll-interval-ms",
      ],
      boolean: ["help", "json"],
    });
    if (args.help) {
      console.log(deps.usageTaskWait());
      return;
    }
    const taskId = deps.getSingleString(args, "task-id");
    if (!taskId) deps.fail(`Missing required --task-id.\n\n${deps.usageTaskWait()}`);
    const token = deps.getSingleString(args, "token");
    const region = deps.getSingleString(args, "region");
    const isJson = Boolean(args.json);
    const body: JsonRecord = {};
    const type = parseTaskTypeOrFail(deps.getSingleString(args, "type"), deps);
    const responseFormat = parseResponseFormatOrFail(deps.getSingleString(args, "response-format"), deps);
    if (type) body.type = type;
    body.response_format = responseFormat;
    const waitTimeoutSeconds = parsePositiveNumberOption(args, "wait-timeout-seconds", deps);
    if (waitTimeoutSeconds !== undefined) body.wait_timeout_seconds = waitTimeoutSeconds;
    const pollIntervalMs = parsePositiveNumberOption(args, "poll-interval-ms", deps);
    if (pollIntervalMs !== undefined) body.poll_interval_ms = pollIntervalMs;

    const pick = await deps.pickDirectTokenForTask(token, region);
    const normalized: unknown = await waitForTaskResponse(
      taskId,
      pick.token,
      buildRegionInfo(pick.region),
      {
        type,
        responseFormat,
        waitTimeoutSeconds: typeof body.wait_timeout_seconds === "number" ? body.wait_timeout_seconds : undefined,
        pollIntervalMs: typeof body.poll_interval_ms === "number" ? body.poll_interval_ms : undefined,
      }
    );

    const taskInfo = collectTaskInfo(normalized, deps);
    if (!taskInfo) {
      if (isJson) {
        deps.printCommandJson("task.wait", deps.unwrapBody(normalized));
      } else {
        deps.printJson(deps.unwrapBody(normalized));
      }
      return;
    }
    if (isJson) deps.printCommandJson("task.wait", taskInfo);
    else printTaskInfo(taskInfo, deps);
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

    const token = deps.getSingleString(args, "token");
    const region = deps.getSingleString(args, "region");
    const type = deps.getSingleString(args, "type");
    const countRaw = deps.getSingleString(args, "count");
    const count = countRaw ? Number(countRaw) : 20;
    const isJson = Boolean(args.json);

    if (type && type !== "image" && type !== "video" && type !== "all") {
      deps.fail(`Invalid --type: ${type}. Use image, video, or all.`);
    }

    const pick = await deps.pickDirectTokenForTask(token, region);
    const result = await getAssetList(
      pick.token,
      buildRegionInfo(pick.region),
      {
        count: Number.isFinite(count) && count > 0 ? count : 20,
        type: type as AssetListOptions["type"],
      }
    );

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
      const time = item.createdTime > 0
        ? new Date(item.createdTime * 1000).toLocaleString()
        : "-";
      const modelShort = item.modelName || item.modelReqKey || "-";
      const promptShort = item.prompt.length > 50 ? item.prompt.slice(0, 50) + "..." : item.prompt;
      console.log(`${item.id}  ${typeLabel}  ${statusLabel.padEnd(4)}  ${time}  ${modelShort.padEnd(20)}  ${promptShort}`);
      if (item.imageUrl) {
        console.log(`         ${item.imageUrl}`);
      }
    }
  };

  return {
    handleModelsList,
    handleModelsRefresh,
    handleTaskGet,
    handleTaskWait,
    handleTaskList,
    printTaskInfo: (task) => {
      const normalized = collectTaskInfo(task, deps);
      if (!normalized) {
        deps.printJson(task);
        return;
      }
      printTaskInfo(normalized, deps);
    },
  };
}
