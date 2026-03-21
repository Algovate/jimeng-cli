import axios, { type AxiosInstance } from "axios";
import fs from "node:fs";
import path from "node:path";
import FormData from "form-data";

import type { McpConfig } from "./config.ts";
import type { JsonObject, MultipartUploadFile } from "./types.ts";

export interface McpRequestOptions {
  token?: string;
}

export class JimengApiClient {
  private readonly http: AxiosInstance;
  private readonly defaultToken?: string;

  constructor(config: McpConfig) {
    this.defaultToken = config.apiToken;
    this.http = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: config.httpTimeoutMs
    });
  }

  private buildHeaders(options?: McpRequestOptions): Record<string, string> {
    const token = options?.token || this.defaultToken;
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    options?: McpRequestOptions,
    body?: JsonObject
  ): Promise<T> {
    if (method === "GET") {
      const { data } = await this.http.get<T>(path, {
        headers: this.buildHeaders(options)
      });
      return data;
    }

    const { data } = await this.http.post<T>(path, body, {
      headers: this.buildHeaders(options)
    });
    return data;
  }

  async healthCheck(): Promise<any> {
    return this.request("GET", "/ping");
  }

  async listModels(options?: McpRequestOptions): Promise<any> {
    return this.request("GET", "/v1/models", options);
  }

  async generateImage(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    return this.request("POST", "/v1/images/generations", options, body);
  }

  async editImage(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    return this.request("POST", "/v1/images/compositions", options, body);
  }

  async generateVideo(body: Record<string, unknown>, options?: McpRequestOptions): Promise<any> {
    return this.request("POST", "/v1/videos/generations", options, body);
  }

  async getTask(
    taskId: string,
    options?: McpRequestOptions,
    query?: { type?: string; response_format?: string }
  ): Promise<any> {
    const search = new URLSearchParams();
    if (query?.type) search.set("type", query.type);
    if (query?.response_format) search.set("response_format", query.response_format);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return this.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}${suffix}`, options);
  }

  async waitTask(
    taskId: string,
    body: Record<string, unknown>,
    options?: McpRequestOptions
  ): Promise<any> {
    return this.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/wait`, options, body);
  }

  async generateVideoOmni(
    body: JsonObject,
    options?: McpRequestOptions,
    uploadFiles: MultipartUploadFile[] = []
  ): Promise<any> {
    if (uploadFiles.length === 0) {
      return this.request("POST", "/v1/videos/generations", options, body);
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item != null) form.append(key, String(item));
        }
        continue;
      }
      form.append(key, String(value));
    }

    for (const file of uploadFiles) {
      form.append(file.fieldName, fs.createReadStream(file.filePath), {
        filename: path.basename(file.filePath)
      });
    }

    const headers = {
      ...this.buildHeaders(options),
      ...form.getHeaders()
    };
    const { data } = await this.http.post("/v1/videos/generations", form, { headers });
    return data;
  }
}
