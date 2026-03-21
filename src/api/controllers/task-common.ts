import util from "@/lib/util.ts";

export interface AsyncTaskInfo {
  task_id: string;
  type: "image" | "video";
  status: number;
  fail_code: string | null;
  created: number;
  data: null;
}

export function buildPendingTaskInfo(taskId: string, type: "image" | "video"): AsyncTaskInfo {
  return {
    task_id: taskId,
    type,
    status: 20,
    fail_code: null,
    created: util.unixTimestamp(),
    data: null,
  };
}

export function buildPollerOptions(
  waitTimeoutSeconds: number | undefined,
  pollIntervalMs: number | undefined,
  defaultTimeoutSeconds: number,
  defaultPollIntervalMs: number,
  defaultMaxPollCount: number
): { timeoutSeconds: number; pollInterval: number; maxPollCount: number } {
  const timeoutSeconds = Number.isFinite(waitTimeoutSeconds) && waitTimeoutSeconds! > 0
    ? Math.floor(waitTimeoutSeconds!)
    : defaultTimeoutSeconds;
  const pollInterval = Number.isFinite(pollIntervalMs) && pollIntervalMs! > 0
    ? Math.floor(pollIntervalMs!)
    : defaultPollIntervalMs;
  const computedMaxPollCount = Math.max(1, Math.ceil((timeoutSeconds * 1000) / pollInterval));
  return {
    timeoutSeconds,
    pollInterval,
    maxPollCount: Math.max(defaultMaxPollCount, computedMaxPollCount),
  };
}
