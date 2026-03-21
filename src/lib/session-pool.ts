import path from "path";
import fs from "fs-extra";
import _ from "lodash";

import logger from "@/lib/logger.ts";
import {
  assertTokenWithoutRegionPrefix,
  buildRegionInfo,
  getCredit,
  getTokenLiveStatus,
  parseRegionCode,
  RegionCode,
  request,
} from "@/api/controllers/core.ts";
import {
  IMAGE_MODEL_MAP,
  IMAGE_MODEL_MAP_ASIA,
  IMAGE_MODEL_MAP_US,
  VIDEO_MODEL_MAP,
  VIDEO_MODEL_MAP_ASIA,
  VIDEO_MODEL_MAP_US,
} from "@/api/consts/common.ts";

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
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private roundRobinCursor = 0;

  constructor() {
    this.enabled = process.env.TOKEN_POOL_ENABLED !== "false";
    this.filePath = path.resolve(
      process.env.TOKEN_POOL_FILE || "configs/token-pool.json"
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
    const entries = this.getEntries(false);
    const enabledCount = entries.filter((item) => item.enabled).length;
    const liveCount = entries.filter((item) => item.enabled && item.live === true).length;
    const missingRegionCount = entries.filter((item) => !item.region).length;
    return {
      enabled: this.enabled,
      filePath: this.filePath,
      pickStrategy: this.pickStrategy,
      healthCheckIntervalMs: this.healthCheckIntervalMs,
      fetchCreditOnCheck: this.fetchCreditOnCheck,
      autoDisableEnabled: this.autoDisableEnabled,
      autoDisableFailures: this.autoDisableFailures,
      total: entries.length,
      enabledCount,
      liveCount,
      missingRegionCount,
      lastHealthCheckAt: this.lastHealthCheckAt || null
    };
  }

  getEntries(maskToken = true): TokenPoolEntry[] {
    const items = Array.from(this.entryMap.values()).map((item) => ({ ...item }));
    if (!maskToken) return items;
    return items.map((item) => ({
      ...item,
      token: this.maskToken(item.token)
    }));
  }

  getAllTokens(options: { onlyEnabled?: boolean; preferLive?: boolean } = {}): string[] {
    const { onlyEnabled = true, preferLive = true } = options;
    const entries = this.getEntries(false).filter((item) => {
      if (onlyEnabled && !item.enabled) return false;
      if (preferLive && item.live === false) return false;
      return true;
    });
    return entries.map((item) => item.token);
  }

  getTokenEntry(token: string): TokenPoolEntry | null {
    const entry = this.entryMap.get(token);
    return entry ? { ...entry } : null;
  }

  pickTokenFromAuthorization(authorization?: string): string | null {
    return this.pickTokenFromAuthorizationDetailed(authorization).token;
  }

  pickTokenFromAuthorizationDetailed(authorization?: string): AuthorizationTokenPickResult {
    if (_.isString(authorization)) {
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
      return { token: _.sample(tokens) || null, error: null };
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
    return _.sample(tokens) || null;
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
    if (_.isString(xRegion) && xRegion.trim().length > 0 && !xRegionCode) {
      return { token: null, region: null, error: "unsupported_region", reason: "X-Region 仅支持 cn/us/hk/jp/sg" };
    }

    const authParseResult = this.parseAuthorizationTokens(authorization);
    if (authParseResult.error) {
      return { token: null, region: null, error: authParseResult.error };
    }

    const authTokens = authParseResult.tokens;
    const candidates = authTokens.length > 0
      ? authTokens.map((token) => this.buildCandidateFromAuthToken(token, xRegionCode))
      : this.getEntries(false).map((entry) => this.buildCandidateFromPoolEntry(entry));

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
        reason: `token ${this.maskToken(prefixedCandidate.token)} 使用了已废弃的 region 前缀`,
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
      await this.persistToDisk();
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
      await this.persistToDisk();
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
    await this.persistToDisk();
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
    await this.persistToDisk();
    return true;
  }

  async reloadFromDisk(): Promise<void> {
    await this.loadFromDisk();
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
    const entries = this.getEntries(false).filter((item) => item.enabled);
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
              } catch (err: any) {
                current.lastError = `credit_check_failed: ${err?.message || String(err)}`;
              }
            }
          } else {
            invalid++;
            current.consecutiveFailures++;
            current.lastError = "token_not_live";
          }
        } catch (err: any) {
          invalid++;
          current.live = false;
          current.consecutiveFailures++;
          current.lastError = err?.message || String(err);
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
      await this.persistToDisk();
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
        logger.warn(`Token pool health check failed: ${err?.message || String(err)}`);
      });
    }, this.healthCheckIntervalMs);
    if (typeof this.healthCheckTimer.unref === "function") this.healthCheckTimer.unref();
  }

  private async loadFromDisk() {
    await fs.ensureDir(path.dirname(this.filePath));
    if (!await fs.pathExists(this.filePath)) {
      await this.persistToDisk();
      return;
    }
    let data: TokenPoolFile | null = null;
    try {
      data = await fs.readJson(this.filePath);
    } catch (err: any) {
      logger.warn(`Token pool file parse failed, fallback to empty: ${err?.message || String(err)}`);
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
        live: _.isBoolean(raw.live) ? raw.live : undefined,
        lastCheckedAt: _.isFinite(Number(raw.lastCheckedAt)) ? Number(raw.lastCheckedAt) : undefined,
        lastError: _.isString(raw.lastError) ? raw.lastError : undefined,
        lastCredit: _.isFinite(Number(raw.lastCredit)) ? Number(raw.lastCredit) : undefined,
        consecutiveFailures: Math.max(0, Number(raw.consecutiveFailures) || 0),
        allowedModels: this.normalizeStringArray(raw.allowedModels),
        capabilityTags: this.normalizeStringArray(raw.capabilityTags),
        dynamicCapabilities: this.normalizeDynamicCapabilities(raw.dynamicCapabilities),
      });
    }
    this.entryMap.clear();
    for (const [token, item] of nextMap.entries()) this.entryMap.set(token, item);
  }

  private async persistToDisk() {
    await fs.ensureDir(path.dirname(this.filePath));
    const payload: TokenPoolFile = {
      updatedAt: Date.now(),
      tokens: this.getEntries(false)
    };
    await fs.writeJson(this.filePath, payload, { spaces: 2 });
  }

  private maskToken(token: string) {
    if (token.length <= 10) return "***";
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }

  private parseAuthorizationTokens(authorization?: string): { tokens: string[]; error: AuthorizationTokenError | null } {
    if (!_.isString(authorization) || authorization.trim().length === 0) {
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
      if (_.isString(item)) {
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
        throw new Error(`token ${this.maskToken(token)} 缺少有效 region（仅支持 cn/us/hk/jp/sg）`);
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
      updatedAt: _.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : undefined,
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
    return _.sample(candidates) || candidates[0];
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
    } catch (err: any) {
      item.lastError = `dynamic_capability_refresh_failed: ${err?.message || String(err)}`;
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
    const reverseMap = this.getReverseModelMapByRegion(regionCode);
    const imageConfig = await request("post", "/mweb/v1/get_common_config", token, regionInfo, {
      data: {},
      params: { needCache: true, needRefresh: false },
    });
    const videoConfig = await request("post", "/mweb/v1/video_generate/get_common_config", token, regionInfo, {
      data: { scene: "generate_video", params: {} },
    });

    const imageReqKeys = Array.isArray(imageConfig?.model_list)
      ? imageConfig.model_list
          .map((item: any) => (typeof item?.model_req_key === "string" ? item.model_req_key : ""))
          .filter(Boolean)
      : [];
    const videoReqKeys = Array.isArray(videoConfig?.model_list)
      ? videoConfig.model_list
          .map((item: any) => (typeof item?.model_req_key === "string" ? item.model_req_key : ""))
          .filter(Boolean)
      : [];
    const imageModels = imageReqKeys.map((key) => reverseMap[key]).filter(Boolean);
    const videoModels = videoReqKeys.map((key) => reverseMap[key]).filter(Boolean);
    const capabilityTags = new Set<string>();
    // Capability matching should be based on translated modelIds, not upstream req keys.
    for (const model of videoModels) {
      if (model.includes("seedance_40")) capabilityTags.add("omni_reference");
      if (model.includes("veo3")) capabilityTags.add("veo3");
      if (model.includes("sora2")) capabilityTags.add("sora2");
    }
    return {
      imageModels: imageModels.length ? Array.from(new Set(imageModels)) : undefined,
      videoModels: videoModels.length ? Array.from(new Set(videoModels)) : undefined,
      capabilityTags: capabilityTags.size ? Array.from(capabilityTags) : undefined,
    };
  }

  private getReverseModelMapByRegion(region: RegionCode): Record<string, string> {
    const maps = region === "us"
      ? [IMAGE_MODEL_MAP_US, VIDEO_MODEL_MAP_US]
      : (region === "hk" || region === "jp" || region === "sg")
        ? [IMAGE_MODEL_MAP_ASIA, VIDEO_MODEL_MAP_ASIA]
        : [IMAGE_MODEL_MAP, VIDEO_MODEL_MAP];
    const reverse: Record<string, string> = {};
    for (const map of maps) {
      for (const [modelId, reqKey] of Object.entries(map)) {
        reverse[reqKey] = modelId;
      }
    }
    return reverse;
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