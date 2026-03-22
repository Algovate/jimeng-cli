import {
  IMAGE_MODEL_MAP,
  IMAGE_MODEL_MAP_ASIA,
  IMAGE_MODEL_MAP_US,
  VIDEO_MODEL_MAP,
  VIDEO_MODEL_MAP_ASIA,
  VIDEO_MODEL_MAP_US,
} from "@/api/consts/common.ts";
import {
  assertTokenWithoutRegionPrefix,
  buildRegionInfo,
  parseProxyFromToken,
  parseRegionCode,
  RegionCode,
  request,
} from "@/api/controllers/core.ts";
import tokenPool, { type DynamicCapabilitiesRefreshResult } from "@/lib/session-pool.ts";

type ModelItem = {
  id: string;
  object: "model";
  owned_by: "jimeng-cli";
  model_type: "image" | "video";
  model_req_key?: string;
  model_name?: string;
  description?: string;
  capabilities?: string[];
};

type CachedResult = {
  expiresAt: number;
  data: ModelItem[];
  source: "upstream" | "fallback";
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_TOKEN = "test_token";
const modelCache = new Map<string, CachedResult>();

function mapVideoDescription(id: string): string | undefined {
  if (id.includes("veo3.1")) return "即梦AI视频生成模型 veo3.1";
  if (id.includes("veo3")) return "即梦AI视频生成模型 veo3";
  if (id.includes("sora2")) return "即梦AI视频生成模型 sora2";
  if (id.includes("seedance-2.0-fast")) return "即梦AI视频生成模型 seedance 2.0-fast";
  if (id.includes("seedance-2.0")) return "即梦AI视频生成模型 seedance 2.0";
  if (id.includes("3.5-pro")) return "即梦AI视频生成模型 3.5 专业版";
  if (id.includes("3.0-fast")) return "即梦AI视频生成模型 3.0 极速版";
  if (id.includes("3.0-pro")) return "即梦AI视频生成模型 3.0 专业版";
  if (id.includes("3.0")) return "即梦AI视频生成模型 3.0";
  if (id.includes("2.0-pro")) return "即梦AI视频生成模型 2.0 专业版";
  if (id.includes("2.0")) return "即梦AI视频生成模型 2.0";
  return undefined;
}

function mapImageDescription(id: string): string {
  if (id.includes("5.0")) return "即梦AI图像模型 5.0";
  if (id.includes("4.6")) return "即梦AI图像模型 4.6";
  if (id.includes("4.5")) return "即梦AI图像模型 4.5";
  if (id.includes("4.1")) return "即梦AI图像模型 4.1";
  if (id.includes("4.0")) return "即梦AI图像模型 4.0";
  if (id.includes("3.1")) return "即梦AI图像模型 3.1";
  if (id.includes("3.0")) return "即梦AI图像模型 3.0";
  return `即梦AI图像模型 ${id}`;
}

type UpstreamModelMeta = {
  reqKey: string;
  modelName?: string;
  modelTip?: string;
  capabilities: string[];
};

function buildModelItem(modelId: string, meta?: UpstreamModelMeta): ModelItem {
  const modelType: "image" | "video" = modelId.startsWith("jimeng-video-") ? "video" : "image";
  const item: ModelItem = {
    id: modelId,
    object: "model",
    owned_by: "jimeng-cli",
    model_type: modelType,
  };
  if (meta?.reqKey) item.model_req_key = meta.reqKey;
  if (meta?.modelName) item.model_name = meta.modelName;
  if (meta?.capabilities?.length) item.capabilities = Array.from(new Set(meta.capabilities)).sort();

  if (meta?.modelTip) {
    item.description = meta.modelTip;
  } else if (modelType === "video") {
    item.description = mapVideoDescription(modelId);
  } else {
    item.description = mapImageDescription(modelId);
  }
  return item;
}

function parseFirstToken(authorization?: string): string | undefined {
  if (!authorization || !/^Bearer\s+/i.test(authorization)) return undefined;
  const raw = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!raw) return undefined;
  const first = raw.split(",")[0]?.trim();
  return first || undefined;
}

function resolveToken(authorization?: string): string | undefined {
  const fromAuth = parseFirstToken(authorization);
  if (fromAuth) return fromAuth;
  const fromPool = tokenPool.getAllTokens({ onlyEnabled: true, preferLive: true })[0];
  return fromPool || undefined;
}

function getRegionalMaps(region: RegionCode): Record<string, string>[] {
  if (region === "us") return [IMAGE_MODEL_MAP_US, VIDEO_MODEL_MAP_US];
  if (region === "hk" || region === "jp" || region === "sg") return [IMAGE_MODEL_MAP_ASIA, VIDEO_MODEL_MAP_ASIA];
  if (region === "cn") return [IMAGE_MODEL_MAP, VIDEO_MODEL_MAP];
  return [IMAGE_MODEL_MAP, IMAGE_MODEL_MAP_US, IMAGE_MODEL_MAP_ASIA, VIDEO_MODEL_MAP, VIDEO_MODEL_MAP_US, VIDEO_MODEL_MAP_ASIA];
}

function resolveRegion(authorization?: string, xRegion?: string): RegionCode {
  const token = resolveToken(authorization);
  const parsedXRegion = parseRegionCode(xRegion);
  if (parsedXRegion) return parsedXRegion;
  if (token) {
    assertTokenWithoutRegionPrefix(token);
    const normalizedToken = parseProxyFromToken(token).token;
    const poolRegion = tokenPool.getTokenEntry(normalizedToken)?.region;
    if (poolRegion) return poolRegion;
    throw new Error("缺少 region。token 未在 pool 中注册时，/v1/models 需要提供请求头 X-Region");
  }
  return "cn";
}

function buildReverseMap(region: RegionCode): Record<string, string> {
  const reverse: Record<string, string> = {};
  for (const map of getRegionalMaps(region)) {
    for (const [modelId, upstreamKey] of Object.entries(map)) {
      reverse[upstreamKey] = modelId;
    }
  }
  return reverse;
}

function buildFallbackModels(region: RegionCode): ModelItem[] {
  const maps = getRegionalMaps(region);
  const modelIds = Array.from(new Set(maps.flatMap((item) => Object.keys(item)))).sort();
  return modelIds.map((id) => buildModelItem(id));
}

function makeCacheKey(region: RegionCode): string {
  return `models|${region}`;
}

function resolveFetchToken(token: string | undefined): string {
  if (!token) return FALLBACK_TOKEN;
  const normalizedToken = parseProxyFromToken(token).token;
  assertTokenWithoutRegionPrefix(normalizedToken);
  return normalizedToken;
}

function extractCapabilities(item: Record<string, unknown>): string[] {
  const features = Array.isArray(item.feats)
    ? item.feats.filter((feature): feature is string => typeof feature === "string" && feature.length > 0)
    : [];
  const options = Array.isArray(item.options)
    ? item.options
        .map((option) =>
          option && typeof option === "object" && typeof (option as Record<string, unknown>).key === "string"
            ? (option as Record<string, string>).key
            : undefined
        )
        .filter((key): key is string => typeof key === "string" && key.length > 0)
    : [];

  return Array.from(new Set([...features, ...options]));
}

async function fetchConfigModelReqKeys(
  token: string,
  region: RegionCode
): Promise<{ imageModels: UpstreamModelMeta[]; videoModels: UpstreamModelMeta[] }> {
  const regionInfo = buildRegionInfo(region);
  const imageConfig = await request("post", "/mweb/v1/get_common_config", token, regionInfo, {
    data: {},
    params: { needCache: true, needRefresh: false },
  });
  const videoConfig = await request("post", "/mweb/v1/video_generate/get_common_config", token, regionInfo, {
    data: { scene: "generate_video", params: {} },
  });

  const imageModels = Array.isArray(imageConfig?.model_list)
    ? imageConfig.model_list
        .map((item: Record<string, unknown>) => {
          const reqKey = item?.model_req_key;
          if (typeof reqKey !== "string" || reqKey.length === 0) return undefined;
          return {
            reqKey,
            modelName: typeof item?.model_name === "string" ? item.model_name : undefined,
            modelTip: typeof item?.model_tip === "string" ? item.model_tip : undefined,
            capabilities: extractCapabilities(item),
          } as UpstreamModelMeta;
        })
        .filter((item): item is UpstreamModelMeta => Boolean(item))
    : [];
  const videoModels = Array.isArray(videoConfig?.model_list)
    ? videoConfig.model_list
        .map((item: Record<string, unknown>) => {
          const reqKey = item?.model_req_key;
          if (typeof reqKey !== "string" || reqKey.length === 0) return undefined;
          return {
            reqKey,
            modelName: typeof item?.model_name === "string" ? item.model_name : undefined,
            modelTip: typeof item?.model_tip === "string" ? item.model_tip : undefined,
            capabilities: extractCapabilities(item),
          } as UpstreamModelMeta;
        })
        .filter((item): item is UpstreamModelMeta => Boolean(item))
    : [];

  return { imageModels, videoModels };
}

export async function getLiveModels(
  authorization?: string,
  xRegion?: string
): Promise<{ source: "upstream" | "fallback"; data: ModelItem[] }> {
  const region = resolveRegion(authorization, xRegion);
  const token = resolveToken(authorization);
  const effectiveToken = resolveFetchToken(token);
  const cacheKey = makeCacheKey(region);
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { source: cached.source, data: cached.data };
  }

  try {
    const reverseMap = buildReverseMap(region);
    const { imageModels, videoModels } = await fetchConfigModelReqKeys(effectiveToken, region);
    const upstreamModels = [...imageModels, ...videoModels];
    const metaByModelId = new Map<string, UpstreamModelMeta>();
    const mapped = upstreamModels
      .map((model) => {
        const modelId = reverseMap[model.reqKey];
        if (modelId && !metaByModelId.has(modelId)) {
          metaByModelId.set(modelId, model);
        }
        return modelId;
      })
      .filter((item): item is string => typeof item === "string" && item.length > 0);
    const modelIds = Array.from(new Set(mapped)).sort();
    if (modelIds.length === 0) {
      throw new Error("model_req_key resolved but none matched local reverse map");
    }

    const data = modelIds.map((id) => buildModelItem(id, metaByModelId.get(id)));

    modelCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      source: "upstream",
      data,
    });

    return { source: "upstream", data };
  } catch {
    const data = buildFallbackModels(region);
    modelCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      source: "fallback",
      data,
    });

    return { source: "fallback", data };
  }
}

export async function refreshAllTokenModels(): Promise<DynamicCapabilitiesRefreshResult[]> {
  return tokenPool.refreshAllDynamicCapabilities();
}