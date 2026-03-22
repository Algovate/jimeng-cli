import minimist from "minimist";

import { buildRegionInfo, type RegionCode } from "@/api/controllers/core.ts";
import { getLiveModels } from "@/api/controllers/models.ts";
import { getTaskResponse, waitForTaskResponse } from "@/api/controllers/tasks.ts";

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
  usageTaskGet: () => string;
  usageTaskWait: () => string;
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
  handleTaskGet: (argv: string[]) => Promise<void>;
  handleTaskWait: (argv: string[]) => Promise<void>;
  printTaskInfo: (task: unknown) => void;
} {
  const handleModelsList = async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: ["region", "token"],
      boolean: ["help", "json", "verbose"],
    });

    if (args.help) {
      console.log(deps.usageModelsList());
      return;
    }

    const region = deps.getRegionWithDefault(args);
    const parsedRegion = deps.parseRegionOrFail(region);
    const token = deps.getSingleString(args, "token");
    await deps.ensureTokenPoolReady();
    const auth = token ? `Bearer ${token}` : undefined;
    const direct = await getLiveModels(auth, parsedRegion || region);
    const normalized: unknown = { object: "list", data: direct.data };

    if (args.json) {
      deps.printCommandJson("models.list", normalized, { region: region || null });
      return;
    }

    const data =
      normalized && typeof normalized === "object" && Array.isArray((normalized as JsonRecord).data)
        ? ((normalized as JsonRecord).data as unknown[])
        : [];

    if (data.length === 0) {
      deps.fail(`No models found in response: ${JSON.stringify(normalized)}`);
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
    const region = deps.getRegionWithDefault(args);
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
    const region = deps.getRegionWithDefault(args);
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

  return {
    handleModelsList,
    handleTaskGet,
    handleTaskWait,
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
