import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { request, RegionInfo } from "@/api/controllers/core.ts";
import { SmartPoller, PollingStatus } from "@/lib/smart-poller.ts";
import { buildPollerOptions } from "@/api/controllers/task-common.ts";
import { extractImageUrls, extractVideoUrl } from "@/lib/image-utils.ts";
import util from "@/lib/util.ts";

export type TaskType = "image" | "video";
export type TaskResponseFormat = "url" | "b64_json";

export interface TaskResponseDataItem {
  url?: string;
  b64_json?: string;
}

export interface TaskResponseShape {
  task_id: string;
  type: TaskType;
  status: number;
  fail_code: string | null;
  created: number;
  data: TaskResponseDataItem[] | null;
}

const IMAGE_INFO_PAYLOAD = {
  width: 2048,
  height: 2048,
  format: "webp",
  image_scene_list: [
    { scene: "smart_crop", width: 360, height: 360, uniq_key: "smart_crop-w:360-h:360", format: "webp" },
    { scene: "smart_crop", width: 480, height: 480, uniq_key: "smart_crop-w:480-h:480", format: "webp" },
    { scene: "smart_crop", width: 720, height: 720, uniq_key: "smart_crop-w:720-h:720", format: "webp" },
    { scene: "smart_crop", width: 720, height: 480, uniq_key: "smart_crop-w:720-h:480", format: "webp" },
    { scene: "normal", width: 2400, height: 2400, uniq_key: "2400", format: "webp" },
    { scene: "normal", width: 1080, height: 1080, uniq_key: "1080", format: "webp" },
    { scene: "normal", width: 720, height: 720, uniq_key: "720", format: "webp" },
    { scene: "normal", width: 480, height: 480, uniq_key: "480", format: "webp" },
    { scene: "normal", width: 360, height: 360, uniq_key: "360", format: "webp" },
  ],
};

function inferTaskType(task: any, fallback?: TaskType): TaskType {
  if (fallback) return fallback;
  const firstItem = task?.item_list?.[0];
  if (firstItem?.video) return "video";
  return "image";
}

export async function getHistoryTaskById(
  taskId: string,
  refreshToken: string,
  regionInfo: RegionInfo
): Promise<any> {
  const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, regionInfo, {
    data: {
      history_ids: [taskId],
      image_info: IMAGE_INFO_PAYLOAD,
    },
  });
  const task = result?.[taskId];
  if (!task) {
    throw new APIException(EX.API_REQUEST_FAILED, `任务不存在: ${taskId}`);
  }
  return task;
}

async function buildTaskData(
  type: TaskType,
  task: any,
  responseFormat: TaskResponseFormat
): Promise<TaskResponseDataItem[] | null> {
  const itemList = Array.isArray(task?.item_list) ? task.item_list : [];
  if (itemList.length === 0) return null;

  if (type === "image") {
    const imageUrls = extractImageUrls(itemList);
    if (imageUrls.length === 0) return null;
    if (responseFormat === "b64_json") {
      const encoded = await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)));
      return encoded.map((b64) => ({ b64_json: b64 }));
    }
    return imageUrls.map((url) => ({ url }));
  }

  const videoUrl = extractVideoUrl(itemList[0]);
  if (!videoUrl) return null;
  if (responseFormat === "b64_json") {
    return [{ b64_json: await util.fetchFileBASE64(videoUrl) }];
  }
  return [{ url: videoUrl }];
}

export async function getTaskResponse(
  taskId: string,
  refreshToken: string,
  regionInfo: RegionInfo,
  options: {
    type?: TaskType;
    responseFormat?: TaskResponseFormat;
  } = {}
): Promise<TaskResponseShape> {
  const task = await getHistoryTaskById(taskId, refreshToken, regionInfo);
  const type = inferTaskType(task, options.type);
  const responseFormat = options.responseFormat || "url";
  return {
    task_id: taskId,
    type,
    status: typeof task?.status === "number" ? task.status : 20,
    fail_code: typeof task?.fail_code === "string" ? task.fail_code : null,
    created: util.unixTimestamp(),
    data: await buildTaskData(type, task, responseFormat),
  };
}

export async function waitForTaskResponse(
  taskId: string,
  refreshToken: string,
  regionInfo: RegionInfo,
  options: {
    type?: TaskType;
    responseFormat?: TaskResponseFormat;
    waitTimeoutSeconds?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<TaskResponseShape> {
  const responseFormat = options.responseFormat || "url";
  const defaultTimeoutSeconds = options.type === "video" ? 3600 : 1800;
  const defaultPollIntervalMs = options.type === "video" ? 20000 : 10000;
  const pollerOptions = buildPollerOptions(
    options.waitTimeoutSeconds,
    options.pollIntervalMs,
    defaultTimeoutSeconds,
    defaultPollIntervalMs,
    900
  );

  const poller = new SmartPoller({
    maxPollCount: pollerOptions.maxPollCount,
    pollInterval: pollerOptions.pollInterval,
    expectedItemCount: 1,
    type: options.type || "image",
    timeoutSeconds: pollerOptions.timeoutSeconds,
  });

  const { data: taskData } = await poller.poll(async () => {
    const task = await getHistoryTaskById(taskId, refreshToken, regionInfo);
    const type = inferTaskType(task, options.type);
    const itemList = Array.isArray(task?.item_list) ? task.item_list : [];
    const itemCount = itemList.length;

    return {
      status: {
        status: typeof task?.status === "number" ? task.status : 20,
        failCode: typeof task?.fail_code === "string" ? task.fail_code : undefined,
        itemCount,
        finishTime: task?.task?.finish_time || 0,
        historyId: taskId,
      } as PollingStatus,
      data: { task, type },
    };
  }, taskId);

  const finalType = inferTaskType(taskData.task, taskData.type);
  return {
    task_id: taskId,
    type: finalType,
    status: typeof taskData.task?.status === "number" ? taskData.task.status : 20,
    fail_code: typeof taskData.task?.fail_code === "string" ? taskData.task.fail_code : null,
    created: util.unixTimestamp(),
    data: await buildTaskData(finalType, taskData.task, responseFormat),
  };
}
