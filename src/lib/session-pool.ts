import path from "path";
import os from "os";
import fs from "fs-extra";

/** Pick a random element from an array. */
function sample<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

import logger from "@/lib/logger.ts";
import { maskToken } from "@/lib/util.ts";
import {
  assertTokenWithoutRegionPrefix,
  buildRegionInfo,
  getCredit,
  getTokenLiveStatus,
  parseRegionCode,
  RegionCode,
} from "@/api/controllers/core.ts";
import {
  buildReverseMap,
  fetchConfigModelReqKeys,
} from "@/api/controllers/models.ts";

export interface TokenDynamicCapabilities {
  imageModels?: string[];
  videoModels?: string[];
  capabilityTags?: string[];
  updatedAt?: number;
}

export interface TokenPoolEntry {
  token: string;
  region?: RegionCode;
  enabled: boolean;
  live?: boolean;
  lastCheckedAt?: number;
  lastError?: string;
  lastCredit?: number;
  consecutiveFailures: number;
  allowedModels?: string[];
  capabilityTags?: string[];
  dynamicCapabilities?: TokenDynamicCapabilities;
}

interface TokenPoolFile {
  updatedAt: number;
  tokens: TokenPoolEntry[];
}

type PickStrategy = "random" | "round_robin";
export type AuthorizationTokenError = "invalid_authorization_format" | "empty_authorization_tokens";
export type RequestTokenError =
  | AuthorizationTokenError
  | "prefixed_token_not_supported"
  | "unsupported_region"
  | "missing_region"
  | "no_matching_token";

export interface AuthorizationTokenPickResult {
  token: string | null;
  error: AuthorizationTokenError | null;
}

export interface RequestTokenPickResult {
  token: string | null;
  region: RegionCode | null;
  error: RequestTokenError | null;
  reason?: string;
}

type TokenTaskType = "image" | "video";

type AddTokenInput = {
  token: string;
  region?: RegionCode;
  enabled?: boolean;
  allowedModels?: string[];
  capabilityTags?: string[];
};

const DYNAMIC_CAPABILITY_TTL_MS = 30 * 60 * 1000;

export interface DynamicCapabilitiesRefreshResult {
  token: string;
  region: string;
  imageModels: number;
  videoModels: number;
  capabilityTags: string[];
  error?: string;
}

class TokenPool {
  private readonly enabled: boolean;
  private readonly filePath: string;
  private readonly healthCheckIntervalMs: number;
  private readonly fetchCreditOnCheck: boolean;
  private readonly autoDisableEnabled: boolean;
  private readonly autoDisableFailures: number;
  private readonly pickStrategy: PickStrategy;

  private readonly entryMap = new Map<string, TokenPoolEntry>();
  private initialized = false;
  private healthChecking = false;
  private lastHealthCheckAt = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private roundRobinCursor = 0;

  constructor() {
    this.enabled = process.env.TOKEN_POOL_ENABLED !== "false";
    this.filePath = path.resolve(
      process.env.TOKEN_POOL_FILE || path.join(os.homedir(), ".jimeng", "token-pool.json")
    );
    this.healthCheckIntervalMs = Number(
      process.env.TOKEN_POOL_HEALTHCHECK_INTERVAL_MS || 10 * 60 * 1000
    );
    this.fetchCreditOnCheck = process.env.TOKEN_POOL_FETCH_CREDIT === "true";
    this.autoDisableEnabled = process.env.TOKEN_POOL_AUTO_DISABLE !== "false";
    this.autoDisableFailures = Math.max(
      1,
      Number(process.env.TOKEN_POOL_AUTO_DISABLE_FAILURES || 2)
    );
    this.pickStrategy = process.env.TOKEN_POOL_STRATEGY === "round_robin"
      ? "round_robin"
      : "random";
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.enabled) {
      logger.info("Token pool disabled by TOKEN_POOL_ENABLED=false");
      return;
    }
    await this.loadFromDisk();
    this.startHealthCheckLoop();
    logger.info(
      `Token pool initialized: total=${this.entryMap.size}, file=${this.filePath}`
    );
  }

  getSummary() {
    let enabledCount = 0;
    let liveCount = 0;
    let missingRegionCount = 0;
    for (const item of this.entryMap.values()) {
      if (item.enabled) enabledCount++;
      if (item.enabled && item.live === true) liveCount++;
      if (!item.region) missingRegionCount++;
    }
    return {
      enabled: this.enabled,
      filePath: this.filePath,
      pickStrategy: this.pickStrategy,
      healthCheckIntervalMs: this.healthCheckIntervalMs,
      fetchCreditOnCheck: this.fetchCreditOnCheck,
      autoDisableEnabled: this.autoDisableEnabled,
      autoDisableFailures: this.autoDisableFailures,
      total: this.entryMap.size,
      enabledCount,
      liveCount,
      missingRegionCount,
      lastHealthCheckAt: this.lastHealthCheckAt || null
    };
  }

  getEntries(shouldMask = true): TokenPoolEntry[] {
    const items = Array.from(this.entryMap.values());
    if (!shouldMask) return items;
    return items.map((item) => ({
      ...item,
      token: maskToken(item.token)
    }));
  }

  getAllTokens(options: { onlyEnabled?: boolean; preferLive?: boolean } = {}): string[] {
    const { onlyEnabled = true, preferLive = true } = options;
    const tokens: string[] = [];
    for (const item of this.entryMap.values()) {
      if (onlyEnabled && !item.enabled) continue;
      if (preferLive && item.live === false) continue;
      tokens.push(item.token);
    }
    return tokens;
  }

  getTokenEntry(token: string): TokenPoolEntry | null {
    const entry = this.entryMap.get(token);
    return entry ? { ...entry } : null;
  }

  pickTokenFromAuthorization(authorization?: string): string | null {
    return this.pickTokenFromAuthorizationDetailed(authorization).token;
  }

  pickTokenFromAuthorizationDetailed(authorization?: string): AuthorizationTokenPickResult {
    if (typeof authorization === "string") {
      if (authorization.trim().length === 0) return { token: this.pickToken(), error: null };
      if (!/^Bearer\s+/i.test(authorization)) {
        return { token: null, error: "invalid_authorization_format" };
      }
      const tokens = authorization
        .replace(/^Bearer\s+/i, "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
      if (tokens.length === 0) {
        return { token: null, error: "empty_authorization_tokens" };
      }
      return { token: sample(tokens) || null, error: null };
    }
    return { token: this.pickToken(), error: null };
  }

  pickToken(): string | null {
    if (!this.enabled) return null;
    const tokens = this.getAllTokens({ onlyEnabled: true, preferLive: true });
    if (tokens.length === 0) return null;
    if (this.pickStrategy === "round_robin") {
      const token = tokens[this.roundRobinCursor % tokens.length];
      this.roundRobinCursor++;
      return token;
    }
    return sample(tokens) || null;
  }

  pickTokenForRequest({
    authorization,
    requestedModel,
    taskType,
    requiredCapabilityTags = [],
    xRegion,
  }: {
    authorization?: string;
    requestedModel: string;
    taskType: TokenTaskType;
    requiredCapabilityTags?: string[];
    xRegion?: string;
  }): RequestTokenPickResult {
    const xRegionCode = parseRegionCode(xRegion);
    if (typeof xRegion === "string" && xRegion.trim().length > 0 && !xRegionCode) {
      return { token: null, region: null, error: "unsupported_region", reason: "X-Region 仅支持 cn/us/hk/jp/sg" };
    }

    const authParseResult = this.parseAuthorizationTokens(authorization);
    if (authParseResult.error) {
      return { token: null, region: null, error: authParseResult.error };
    }

    const authTokens = authParseResult.tokens;
    const candidates = authTokens.length > 0
      ? authTokens.map((token) => this.buildCandidateFromAuthToken(token, xRegionCode))
      : Array.from(this.entryMap.values()).map((entry) => this.buildCandidateFromPoolEntry(entry));

    const validCandidates = candidates.filter((item): item is CandidateToken => Boolean(item));
    if (validCandidates.length === 0) {
      return { token: null, region: null, error: "no_matching_token", reason: "未找到可评估的 token 候选集" };
    }

    const prefixedCandidate = validCandidates.find((item) => item.prefixedToken);
    if (prefixedCandidate) {
      return {
        token: null,
        region: null,
        error: "prefixed_token_not_supported",
        reason: `token ${maskToken(prefixedCandidate.token)} 使用了已废弃的 region 前缀`,
      };
    }

    const regionLockedCandidates = validCandidates.filter((item) =>
      xRegionCode ? item.region === xRegionCode : true
    );
    const regionReadyCandidates = regionLockedCandidates.filter((item) => Boolean(item.region));
    if (regionReadyCandidates.length === 0) {
      return { token: null, region: null, error: "missing_region", reason: "候选 token 缺少 region，或与 X-Region 不匹配" };
    }

    const matched = regionReadyCandidates.filter((item) =>
      this.matchesModelAndCapabilities(item, requestedModel, taskType, requiredCapabilityTags)
    );
    if (matched.length === 0) {
      return {
        token: null,
        region: xRegionCode || regionReadyCandidates[0].region || null,
        error: "no_matching_token",
        reason: `region 已匹配，但无 token 支持模型 ${requestedModel}`,
      };
    }

    const selected = this.pickCandidate(matched);
    return { token: selected.token, region: selected.region, error: null };
  }

  async addTokens(
    rawTokens: Array<string | AddTokenInput>,
    options: { defaultRegion?: RegionCode } = {}
  ): Promise<{ added: number; total: number }> {
    if (!this.enabled) return { added: 0, total: 0 };
    const normalized = this.normalizeAddTokens(rawTokens, options.defaultRegion);
    let added = 0;
    for (const tokenInput of normalized) {
      const token = tokenInput.token;
      if (this.entryMap.has(token)) continue;
      assertTokenWithoutRegionPrefix(token);
      this.entryMap.set(token, {
        token,
        region: tokenInput.region,
        enabled: tokenInput.enabled !== false,
        live: undefined,
        lastCheckedAt: undefined,
        lastError: undefined,
        lastCredit: undefined,
        consecutiveFailures: 0,
        allowedModels: tokenInput.allowedModels?.length ? Array.from(new Set(tokenInput.allowedModels)) : undefined,
        capabilityTags: tokenInput.capabilityTags?.length ? Array.from(new Set(tokenInput.capabilityTags)) : undefined,
        dynamicCapabilities: undefined,
      });
      added++;
    }
    if (added > 0) {
      await this.persistToDiskNow();
      logger.info(`Token pool add tokens: added=${added}, total=${this.entryMap.size}`);
    }
    return { added, total: this.entryMap.size };
  }

  async removeTokens(rawTokens: string[]): Promise<{ removed: number; total: number }> {
    if (!this.enabled) return { removed: 0, total: 0 };
    const tokens = rawTokens.map((token) => token.trim()).filter(Boolean);
    let removed = 0;
    for (const token of tokens) {
      if (this.entryMap.delete(token)) removed++;
    }
    if (removed > 0) {
      await this.persistToDiskNow();
      logger.info(`Token pool remove tokens: removed=${removed}, total=${this.entryMap.size}`);
    }
    return { removed, total: this.entryMap.size };
  }

  async setTokenEnabled(token: string, enabled: boolean): Promise<boolean> {
    if (!this.enabled) return false;
    const item = this.entryMap.get(token);
    if (!item) return false;
    item.enabled = enabled;
    if (!enabled) item.live = false;
    await this.persistToDiskNow();
    return true;
  }

  async syncTokenCheckResult(token: string, live: boolean): Promise<boolean> {
    if (!this.enabled) return false;
    const item = this.entryMap.get(token);
    if (!item) return false;
    item.lastCheckedAt = Date.now();
    item.live = live;
    if (live) {
      // Manual token check confirmed token is valid; recover from auto-disable.
      item.enabled = true;
      item.consecutiveFailures = 0;
      item.lastError = undefined;
    } else {
      item.consecutiveFailures++;
      item.lastError = "token_not_live";
      if (this.autoDisableEnabled && item.consecutiveFailures >= this.autoDisableFailures) {
        item.enabled = false;
      }
    }
    this.persistToDisk();
    return true;
  }

  async reloadFromDisk(): Promise<void> {
    await this.loadFromDisk();
  }

  /**
   * Refresh dynamic capabilities for a single pool token and persist to disk.
   * Throws if the token is not found in pool or has no region.
   */
  async refreshDynamicCapabilitiesForToken(token: string): Promise<TokenDynamicCapabilities> {
    if (!this.enabled) throw new Error("Token pool disabled");
    const item = this.entryMap.get(token);
    if (!item) throw new Error(`Token not found in pool: ${maskToken(token)}`);
    if (!item.region) throw new Error(`Token ${maskToken(token)} has no region`);
    const regionInfo = buildRegionInfo(item.region);
    const capabilities = await this.fetchDynamicCapabilities(token, regionInfo);
    item.dynamicCapabilities = { ...capabilities, updatedAt: Date.now() };
    this.persistToDisk();
    return item.dynamicCapabilities;
  }

  /**
   * Refresh dynamic capabilities for all enabled+live pool tokens.
   * Returns a per-token result summary.
   */
  async refreshAllDynamicCapabilities(): Promise<DynamicCapabilitiesRefreshResult[]> {
    if (!this.enabled) return [];
    const entries = Array.from(this.entryMap.values()).filter(
      (item) => item.enabled && item.live !== false && Boolean(item.region)
    );
    if (entries.length === 0) return [];

    const results = await Promise.all(
      entries.map(async (entry): Promise<DynamicCapabilitiesRefreshResult> => {
        try {
          const regionInfo = buildRegionInfo(entry.region!);
          const capabilities = await this.fetchDynamicCapabilities(entry.token, regionInfo);
          const current = this.entryMap.get(entry.token);
          if (current) {
            current.dynamicCapabilities = { ...capabilities, updatedAt: Date.now() };
          }
          return {
            token: maskToken(entry.token),
            region: entry.region!,
            imageModels: capabilities.imageModels?.length ?? 0,
            videoModels: capabilities.videoModels?.length ?? 0,
            capabilityTags: capabilities.capabilityTags ?? [],
          };
        } catch (err: unknown) {
          return {
            token: maskToken(entry.token),
            region: entry.region!,
            imageModels: 0,
            videoModels: 0,
            capabilityTags: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    this.persistToDisk();
    return results;
  }

  async runHealthCheck(): Promise<{
    checked: number;
    live: number;
    invalid: number;
    disabled: number;
  }> {
    if (!this.enabled) return { checked: 0, live: 0, invalid: 0, disabled: 0 };
    if (this.healthChecking) {
      return { checked: 0, live: 0, invalid: 0, disabled: 0 };
    }
    this.healthChecking = true;
    const entries = Array.from(this.entryMap.values()).filter((item) => item.enabled);
    let checked = 0;
    let live = 0;
    let invalid = 0;
    let disabled = 0;

    try {
      for (const item of entries) {
        checked++;
        const current = this.entryMap.get(item.token);
        if (!current || !current.enabled) continue;
        const regionInfo = current.region ? buildRegionInfo(current.region) : null;
        if (!regionInfo) {
          current.live = false;
          current.lastError = "missing_region";
          current.consecutiveFailures++;
          invalid++;
          continue;
        }
        current.lastCheckedAt = Date.now();
        try {
          const isLive = await getTokenLiveStatus(current.token, regionInfo);
          current.live = isLive;
          current.lastError = undefined;
          if (isLive) {
            current.consecutiveFailures = 0;
            live++;
            await this.refreshDynamicCapabilitiesIfNeeded(current, regionInfo);
            if (this.fetchCreditOnCheck) {
              try {
                const credit = await getCredit(current.token, regionInfo);
                current.lastCredit = credit.totalCredit;
              } catch (err: unknown) {
                current.lastError = `credit_check_failed: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
          } else {
            invalid++;
            current.consecutiveFailures++;
            current.lastError = "token_not_live";
          }
        } catch (err: unknown) {
          invalid++;
          current.live = false;
          current.consecutiveFailures++;
          current.lastError = err instanceof Error ? err.message : String(err);
        }

        if (
          this.autoDisableEnabled &&
          current.consecutiveFailures >= this.autoDisableFailures
        ) {
          current.enabled = false;
          current.live = false;
          disabled++;
        }
      }
      this.lastHealthCheckAt = Date.now();
      this.persistToDisk();
      logger.info(
        `Token pool health check done: checked=${checked}, live=${live}, invalid=${invalid}, disabled=${disabled}`
      );
      return { checked, live, invalid, disabled };
    } finally {
      this.healthChecking = false;
    }
  }

  private startHealthCheckLoop() {
    if (!this.enabled || this.healthCheckIntervalMs <= 0) return;
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck().catch((err) => {
        logger.warn(`Token pool health check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.healthCheckIntervalMs);
    if (typeof this.healthCheckTimer.unref === "function") this.healthCheckTimer.unref();
  }

  private async loadFromDisk() {
    await fs.ensureDir(path.dirname(this.filePath));
    if (!await fs.pathExists(this.filePath)) {
      await this.persistToDiskNow();
      return;
    }
    let data: TokenPoolFile | null = null;
    try {
      data = await fs.readJson(this.filePath);
    } catch (err: unknown) {
      logger.warn(`Token pool file parse failed, fallback to empty: ${err instanceof Error ? err.message : String(err)}`);
      data = null;
    }
    const items = Array.isArray(data?.tokens) ? data!.tokens : [];
    const nextMap = new Map<string, TokenPoolEntry>();
    for (const raw of items) {
      const token = String(raw?.token || "").trim();
      if (!token) continue;
      const parsedRegion = parseRegionCode(raw?.region);
      nextMap.set(token, {
        token,
        region: parsedRegion || undefined,
        enabled: raw.enabled !== false,
        live: typeof raw.live === "boolean" ? raw.live : undefined,
        lastCheckedAt: Number.isFinite(Number(raw.lastCheckedAt)) ? Number(raw.lastCheckedAt) : undefined,
        lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
        lastCredit: Number.isFinite(Number(raw.lastCredit)) ? Number(raw.lastCredit) : undefined,
        consecutiveFailures: Math.max(0, Number(raw.consecutiveFailures) || 0),
        allowedModels: this.normalizeStringArray(raw.allowedModels),
        capabilityTags: this.normalizeStringArray(raw.capabilityTags),
        dynamicCapabilities: this.normalizeDynamicCapabilities(raw.dynamicCapabilities),
      });
    }
    this.entryMap.clear();
    for (const [token, item] of nextMap.entries()) this.entryMap.set(token, item);
  }

  private async persistToDiskNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await fs.ensureDir(path.dirname(this.filePath));
    const payload: TokenPoolFile = {
      updatedAt: Date.now(),
      tokens: Array.from(this.entryMap.values())
    };
    await fs.writeJson(this.filePath, payload, { spaces: 2 });
  }

  /** Debounced persist — coalesces rapid successive calls into one disk write. */
  private persistToDisk(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDiskNow().catch((err) => logger.warn(`Token pool persist failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 100);
  }

  private parseAuthorizationTokens(authorization?: string): { tokens: string[]; error: AuthorizationTokenError | null } {
    if (typeof authorization !== "string" || authorization.trim().length === 0) {
      return { tokens: [], error: null };
    }
    if (!/^Bearer\s+/i.test(authorization)) {
      return { tokens: [], error: "invalid_authorization_format" };
    }
    const tokens = authorization
      .replace(/^Bearer\s+/i, "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) return { tokens: [], error: "empty_authorization_tokens" };
    return { tokens, error: null };
  }

  private normalizeAddTokens(rawTokens: Array<string | AddTokenInput>, defaultRegion?: RegionCode): AddTokenInput[] {
    const normalized: AddTokenInput[] = [];
    for (const item of rawTokens) {
      if (typeof item === "string") {
        const token = item.trim();
        if (!token) continue;
        if (!defaultRegion) {
          throw new Error("新增 token 必须指定 region（通过 body.region 或 tokens[].region）");
        }
        normalized.push({ token, region: defaultRegion, enabled: true });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const token = String(item.token || "").trim();
      if (!token) continue;
      const parsedRegion = parseRegionCode(item.region || defaultRegion);
      if (!parsedRegion) {
        throw new Error(`token ${maskToken(token)} 缺少有效 region（仅支持 cn/us/hk/jp/sg）`);
      }
      normalized.push({
        token,
        region: parsedRegion,
        enabled: item.enabled,
        allowedModels: this.normalizeStringArray(item.allowedModels),
        capabilityTags: this.normalizeStringArray(item.capabilityTags),
      });
    }
    return normalized;
  }

  private normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return items.length ? Array.from(new Set(items)) : undefined;
  }

  private normalizeDynamicCapabilities(value: unknown): TokenDynamicCapabilities | undefined {
    if (!value || typeof value !== "object") return undefined;
    const data = value as Record<string, unknown>;
    const dynamic: TokenDynamicCapabilities = {
      imageModels: this.normalizeStringArray(data.imageModels),
      videoModels: this.normalizeStringArray(data.videoModels),
      capabilityTags: this.normalizeStringArray(data.capabilityTags),
      updatedAt: Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : undefined,
    };
    if (!dynamic.imageModels && !dynamic.videoModels && !dynamic.capabilityTags && !dynamic.updatedAt) {
      return undefined;
    }
    return dynamic;
  }

  private buildCandidateFromPoolEntry(entry: TokenPoolEntry): CandidateToken | null {
    return {
      token: entry.token,
      region: entry.region || null,
      allowedModels: entry.allowedModels,
      capabilityTags: entry.capabilityTags,
      dynamicCapabilities: entry.dynamicCapabilities,
      enabled: entry.enabled,
      live: entry.live !== false,
      prefixedToken: this.hasLegacyPrefix(entry.token),
    };
  }

  private buildCandidateFromAuthToken(token: string, xRegion: RegionCode | null): CandidateToken | null {
    const entry = this.entryMap.get(token);
    if (entry) {
      return this.buildCandidateFromPoolEntry(entry);
    }
    return {
      token,
      region: xRegion,
      allowedModels: undefined,
      capabilityTags: undefined,
      dynamicCapabilities: undefined,
      enabled: true,
      live: true,
      prefixedToken: this.hasLegacyPrefix(token),
    };
  }

  private hasLegacyPrefix(token: string): boolean {
    const normalized = token.trim().toLowerCase();
    return normalized.startsWith("us-")
      || normalized.startsWith("hk-")
      || normalized.startsWith("jp-")
      || normalized.startsWith("sg-");
  }

  private pickCandidate(candidates: CandidateToken[]): CandidateToken {
    if (this.pickStrategy === "round_robin") {
      const item = candidates[this.roundRobinCursor % candidates.length];
      this.roundRobinCursor++;
      return item;
    }
    return sample(candidates) || candidates[0];
  }

  private matchesModelAndCapabilities(
    candidate: CandidateToken,
    requestedModel: string,
    taskType: TokenTaskType,
    requiredCapabilityTags: string[]
  ): boolean {
    if (!candidate.enabled || !candidate.live) return false;
    if (!candidate.region) return false;

    if (candidate.allowedModels?.length) {
      if (!candidate.allowedModels.includes(requestedModel)) return false;
    } else {
      const dynamicModels = taskType === "image"
        ? candidate.dynamicCapabilities?.imageModels
        : candidate.dynamicCapabilities?.videoModels;
      if (dynamicModels?.length && !dynamicModels.includes(requestedModel)) return false;
    }

    if (requiredCapabilityTags.length) {
      const mergedTags = new Set([
        ...(candidate.capabilityTags || []),
        ...(candidate.dynamicCapabilities?.capabilityTags || []),
      ]);
      for (const tag of requiredCapabilityTags) {
        if (!mergedTags.has(tag)) return false;
      }
    }
    return true;
  }

  private async refreshDynamicCapabilitiesIfNeeded(item: TokenPoolEntry, regionInfo: ReturnType<typeof buildRegionInfo>): Promise<void> {
    const lastUpdated = item.dynamicCapabilities?.updatedAt || 0;
    if (Date.now() - lastUpdated < DYNAMIC_CAPABILITY_TTL_MS) return;
    try {
      const capabilities = await this.fetchDynamicCapabilities(item.token, regionInfo);
      item.dynamicCapabilities = {
        ...capabilities,
        updatedAt: Date.now(),
      };
    } catch (err: unknown) {
      item.lastError = `dynamic_capability_refresh_failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async fetchDynamicCapabilities(
    token: string,
    regionInfo: ReturnType<typeof buildRegionInfo>
  ): Promise<TokenDynamicCapabilities> {
    const regionCode: RegionCode = regionInfo.isUS
      ? "us"
      : regionInfo.isHK
        ? "hk"
        : regionInfo.isJP
          ? "jp"
          : regionInfo.isSG
            ? "sg"
            : "cn";
    const reverseMap = buildReverseMap(regionCode);
    const { imageModels, videoModels } = await fetchConfigModelReqKeys(token, regionCode);
    const imageIds = imageModels.map((m) => reverseMap[m.reqKey]).filter(Boolean) as string[];
    const videoIds = videoModels.map((m) => reverseMap[m.reqKey]).filter(Boolean) as string[];
    const capabilityTags = new Set<string>();
    for (const model of videoIds) {
      if (model.includes("seedance_40")) capabilityTags.add("omni_reference");
      if (model.includes("veo3")) capabilityTags.add("veo3");
      if (model.includes("sora2")) capabilityTags.add("sora2");
    }
    return {
      imageModels: imageIds.length ? Array.from(new Set(imageIds)) : undefined,
      videoModels: videoIds.length ? Array.from(new Set(videoIds)) : undefined,
      capabilityTags: capabilityTags.size ? Array.from(capabilityTags) : undefined,
    };
  }
}

interface CandidateToken {
  token: string;
  region: RegionCode | null;
  allowedModels?: string[];
  capabilityTags?: string[];
  dynamicCapabilities?: TokenDynamicCapabilities;
  enabled: boolean;
  live: boolean;
  prefixedToken: boolean;
}

export default new TokenPool();