import _ from "lodash";

import { buildRegionInfo, parseRegionCode, RegionInfo } from "@/api/controllers/core.ts";
import Request from "@/lib/request/Request.ts";
import tokenPool from "@/lib/session-pool.ts";

type TaskType = "image" | "video";

export interface TokenSelectionResult {
  token: string;
  regionInfo: RegionInfo;
}

function throwTokenPickError(error: string | null, reason?: string): never {
  if (error === "invalid_authorization_format") {
    throw new Error("Authorization 格式无效。请使用: Authorization: Bearer <token1[,token2,...]>");
  }
  if (error === "empty_authorization_tokens") {
    throw new Error("Authorization 中未包含有效 token。请使用: Authorization: Bearer <token1[,token2,...]>");
  }
  if (error === "unsupported_region") {
    throw new Error("X-Region 无效。仅支持: cn/us/hk/jp/sg");
  }
  if (error === "prefixed_token_not_supported") {
    throw new Error("token 前缀协议已移除。请使用纯 token，并通过 X-Region 或 token-pool.region 指定区域");
  }
  if (error === "missing_region") {
    throw new Error("缺少 region。请设置请求头 X-Region，或先在 token-pool 中为 token 配置 region");
  }
  throw new Error(reason || "缺少可用的token。请传入 Authorization: Bearer <token>，或先添加到 token pool。");
}

export function pickTokenForModelRequest(
  request: Request,
  options: {
    requestedModel: string;
    taskType: TaskType;
    requiredCapabilityTags?: string[];
  }
): TokenSelectionResult {
  const tokenPick = tokenPool.pickTokenForRequest({
    authorization: request.headers.authorization,
    requestedModel: options.requestedModel,
    taskType: options.taskType,
    requiredCapabilityTags: options.requiredCapabilityTags || [],
    xRegion: request.headers["x-region"] as string | undefined,
  });

  if (!tokenPick.token || !tokenPick.region) {
    throwTokenPickError(tokenPick.error, tokenPick.reason);
  }
  return {
    token: tokenPick.token,
    regionInfo: buildRegionInfo(tokenPick.region),
  };
}

export function pickTokenForTaskRequest(request: Request): TokenSelectionResult {
  const regionHeader = request.headers["x-region"] as string | undefined;
  const xRegion = parseRegionCode(regionHeader);
  if (_.isString(regionHeader) && regionHeader.trim().length > 0 && !xRegion) {
    throw new Error("X-Region 无效。仅支持: cn/us/hk/jp/sg");
  }

  const authPick = tokenPool.pickTokenFromAuthorizationDetailed(request.headers.authorization);
  if (authPick.error) {
    throwTokenPickError(authPick.error);
  }

  if (authPick.token) {
    const entry = tokenPool.getTokenEntry(authPick.token);
    const region = xRegion || entry?.region || null;
    if (!region) {
      throw new Error("缺少 region。请设置请求头 X-Region，或先在 token-pool 中为 token 配置 region");
    }
    return { token: authPick.token, regionInfo: buildRegionInfo(region) };
  }

  const candidates = tokenPool
    .getEntries(false)
    .filter((item) => item.enabled && item.live !== false && item.region)
    .filter((item) => (xRegion ? item.region === xRegion : true));

  if (candidates.length === 0) {
    throw new Error("缺少可用的token。请传入 Authorization: Bearer <token>，或先添加到 token pool。");
  }

  const selected = candidates[0];
  return { token: selected.token, regionInfo: buildRegionInfo(selected.region!) };
}
