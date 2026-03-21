import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { pickTokenForTaskRequest } from "@/api/routes/token-selector.ts";
import { parseOptionalNumber } from "@/api/routes/route-helpers.ts";
import {
  getTaskResponse,
  waitForTaskResponse,
  TaskResponseFormat,
  TaskType
} from "@/api/controllers/tasks.ts";

function normalizeTaskType(value: unknown): TaskType | undefined {
  if (value === "image" || value === "video") return value;
  return undefined;
}

function normalizeResponseFormat(value: unknown): TaskResponseFormat {
  return value === "b64_json" ? "b64_json" : "url";
}

export default {
  prefix: "/v1/tasks",
  get: {
    "/:task_id": async (request: Request) => {
      request
        .validate("params.task_id", _.isString)
        .validate("query.type", v => _.isUndefined(v) || _.isString(v))
        .validate("query.response_format", v => _.isUndefined(v) || _.isString(v));

      const taskId = String(request.params.task_id).trim();
      const type = normalizeTaskType(request.query?.type);
      const responseFormat = normalizeResponseFormat(request.query?.response_format);
      const tokenCtx = pickTokenForTaskRequest(request);

      return await getTaskResponse(taskId, tokenCtx.token, tokenCtx.regionInfo, {
        type,
        responseFormat,
      });
    },
  },
  post: {
    "/:task_id/wait": async (request: Request) => {
      request
        .validate("params.task_id", _.isString)
        .validate("body.type", v => _.isUndefined(v) || _.isString(v))
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("body.wait_timeout_seconds", v => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
        .validate("body.poll_interval_ms", v => _.isUndefined(v) || _.isFinite(v) || _.isString(v));

      const taskId = String(request.params.task_id).trim();
      const type = normalizeTaskType(request.body?.type);
      const responseFormat = normalizeResponseFormat(request.body?.response_format);
      const waitTimeoutSeconds = parseOptionalNumber(request.body?.wait_timeout_seconds);
      const pollIntervalMs = parseOptionalNumber(request.body?.poll_interval_ms);
      const tokenCtx = pickTokenForTaskRequest(request);

      return await waitForTaskResponse(taskId, tokenCtx.token, tokenCtx.regionInfo, {
        type,
        responseFormat,
        waitTimeoutSeconds,
        pollIntervalMs,
      });
    },
  },
};
