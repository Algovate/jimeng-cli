import fs from "node:fs";

import { McpToolError } from "../errors.ts";
import type { JsonObject, MultipartUploadFile } from "../types.ts";

export const MAX_IMAGE_SLOTS = 9;
export const MAX_VIDEO_SLOTS = 3;

export type MaterialPrefix = "image_file" | "video_file";
export type MaterialLabel = "image" | "video";

export interface BaseVideoPayloadInput {
  prompt: string;
  model?: string;
  ratio?: string;
  resolution?: string;
  duration?: number;
  response_format?: "url" | "b64_json";
  wait?: boolean;
  wait_timeout_seconds?: number;
  poll_interval_ms?: number;
}

export function buildBaseVideoPayload(
  args: BaseVideoPayloadInput,
  functionMode: "first_last_frames" | "omni_reference"
): JsonObject {
  return {
    prompt: args.prompt,
    model: args.model,
    ratio: args.ratio,
    resolution: args.resolution,
    duration: args.duration ?? 5,
    response_format: args.response_format,
    wait: args.wait,
    wait_timeout_seconds: args.wait_timeout_seconds,
    poll_interval_ms: args.poll_interval_ms,
    functionMode
  };
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function collectStringArray(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((item): item is string => typeof item === "string");
}

export function collectIndexedSlotUrls<TArgs extends Record<string, unknown>>(
  args: TArgs,
  prefix: MaterialPrefix,
  max: number
): Map<number, string> {
  const values = new Map<number, string>();
  for (let i = 1; i <= max; i++) {
    const key = `${prefix}_${i}` as keyof TArgs;
    const slot = args[key];
    if (typeof slot === "string" && slot.length > 0) {
      values.set(i, slot);
    }
  }
  return values;
}

export function assertLocalFilesExist(paths: string[]): void {
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) {
      throw new McpToolError("VALIDATION_ERROR", `Local file not found: ${filePath}`);
    }
  }
}

export function takeNextAvailableSlot(
  occupiedSlots: Set<number>,
  maxSlots: number,
  materialLabel: MaterialLabel
): number {
  for (let i = 1; i <= maxSlots; i++) {
    if (!occupiedSlots.has(i)) {
      occupiedSlots.add(i);
      return i;
    }
  }
  throw new McpToolError(
    "VALIDATION_ERROR",
    `No available ${materialLabel} slot. Maximum supported: ${maxSlots}.`
  );
}

export function appendUrlMaterials(
  body: JsonObject,
  occupiedSlots: Set<number>,
  urls: string[],
  prefix: MaterialPrefix,
  maxSlots: number,
  materialLabel: MaterialLabel
): void {
  for (const url of urls) {
    const slot = takeNextAvailableSlot(occupiedSlots, maxSlots, materialLabel);
    body[`${prefix}_${slot}`] = url;
  }
}

export function appendFileMaterials(
  uploadFiles: MultipartUploadFile[],
  occupiedSlots: Set<number>,
  filePaths: string[],
  prefix: MaterialPrefix,
  maxSlots: number,
  materialLabel: MaterialLabel
): void {
  for (const filePath of filePaths) {
    const slot = takeNextAvailableSlot(occupiedSlots, maxSlots, materialLabel);
    uploadFiles.push({
      fieldName: `${prefix}_${slot}`,
      filePath
    });
  }
}
