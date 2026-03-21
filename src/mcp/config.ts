function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export interface McpConfig {
  apiBaseUrl: string;
  apiToken?: string;
  httpTimeoutMs: number;
  enableAdvancedTools: boolean;
  requireRunConfirm: boolean;
}

export function loadMcpConfig(): McpConfig {
  const apiBaseUrl = (process.env.JIMENG_API_BASE_URL || "http://127.0.0.1:5100").trim();
  const apiToken = process.env.JIMENG_API_TOKEN?.trim();

  return {
    apiBaseUrl,
    apiToken: apiToken || undefined,
    httpTimeoutMs: parseNumber(process.env.MCP_HTTP_TIMEOUT_MS, 120000),
    enableAdvancedTools: parseBoolean(process.env.MCP_ENABLE_ADVANCED_TOOLS, true),
    requireRunConfirm: parseBoolean(process.env.MCP_REQUIRE_RUN_CONFIRM, true)
  };
}
