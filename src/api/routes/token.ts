import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import {
    buildRegionInfo,
    getTokenLiveStatus,
    getCredit,
    parseRegionCode,
    receiveCredit,
    tokenSplit
} from '@/api/controllers/core.ts';
import logger from '@/lib/logger.ts';
import tokenPool from '@/lib/session-pool.ts';

function parseBodyTokens(tokens: any): Array<string | { token: string; region?: string; allowedModels?: string[]; capabilityTags?: string[] }> {
    if (_.isString(tokens)) return tokens.split(",").map((item) => item.trim()).filter(Boolean);
    if (_.isArray(tokens)) {
        return tokens
            .map((item) => {
                if (_.isString(item)) return item.trim();
                if (_.isObject(item) && _.isString((item as any).token)) return item as any;
                return "";
            })
            .filter(Boolean) as Array<string | { token: string; region?: string; allowedModels?: string[]; capabilityTags?: string[] }>;
    }
    return [];
}

function resolveTokenContexts(
    authorization?: string,
    xRegion?: string
): { tokens: Array<{ token: string; region: ReturnType<typeof buildRegionInfo> }>; error: string | null } {
    const headerRegionCode = parseRegionCode(xRegion);
    if (_.isString(xRegion) && xRegion.trim().length > 0 && !headerRegionCode) {
        return { tokens: [], error: "invalid_x_region" };
    }
    if (_.isString(authorization) && authorization.trim().length > 0) {
        if (!/^Bearer\s+/i.test(authorization)) {
            return { tokens: [], error: "invalid_authorization_format" };
        }
        const authTokens = tokenSplit(authorization);
        if (authTokens.length === 0) {
            return { tokens: [], error: "empty_authorization_tokens" };
        }
        const tokens = authTokens.map((token) => {
            const entryRegion = tokenPool.getTokenEntry(token)?.region;
            if (headerRegionCode && entryRegion && entryRegion !== headerRegionCode) return null;
            const regionCode = headerRegionCode || entryRegion;
            if (!regionCode) return null;
            return { token, region: buildRegionInfo(regionCode) };
        }).filter((item): item is { token: string; region: ReturnType<typeof buildRegionInfo> } => Boolean(item));
        if (tokens.length === 0) {
            return { tokens: [], error: "missing_region" };
        }
        return { tokens, error: null };
    }
    const poolEntries = tokenPool.getEntries(false)
        .filter((item) => {
            if (!(item.enabled && item.live !== false && item.region)) return false;
            if (headerRegionCode && item.region !== headerRegionCode) return false;
            return true;
        })
        .map((item) => ({ token: item.token, region: buildRegionInfo(item.region!) }));
    return {
        tokens: poolEntries,
        error: null
    };
}

export default {

    prefix: '/token',

    get: {

        '/pool': async () => {
            return {
                summary: tokenPool.getSummary(),
                items: tokenPool.getEntries(true)
            }
        }

    },

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
                .validate('body.region', v => _.isUndefined(v) || _.isString(v));
            const regionCode = parseRegionCode(request.body.region || request.headers["x-region"]);
            if (!regionCode) throw new Error("缺少有效 region。请在 body.region 或请求头 X-Region 中提供 cn/us/hk/jp/sg");
            const live = await getTokenLiveStatus(request.body.token, buildRegionInfo(regionCode));
            await tokenPool.syncTokenCheckResult(request.body.token, live);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            const { tokens, error } = resolveTokenContexts(
                request.headers.authorization,
                request.headers["x-region"] as string | undefined
            );
            if (error === "invalid_authorization_format") {
                throw new Error("Authorization 格式无效。请使用: Authorization: Bearer <token1[,token2,...]>");
            }
            if (error === "empty_authorization_tokens") {
                throw new Error("Authorization 中未包含有效 token。请使用: Authorization: Bearer <token1[,token2,...]>");
            }
            if (error === "invalid_x_region") {
                throw new Error("X-Region 无效。仅支持: cn/us/hk/jp/sg");
            }
            if (error === "missing_region") {
                throw new Error("缺少 region。Authorization 中的 token 未在 pool 注册时，请提供 X-Region");
            }
            if (tokens.length === 0) throw new Error("无可用token。请传入 Authorization，或先向 token pool 添加带 region 的 token。");
            const points = await Promise.all(tokens.map(async (token) => {
                return {
                    token: token.token,
                    points: await getCredit(token.token, token.region)
                }
            }))
            return points;
        },

        '/receive': async (request: Request) => {
            const { tokens, error } = resolveTokenContexts(
                request.headers.authorization,
                request.headers["x-region"] as string | undefined
            );
            if (error === "invalid_authorization_format") {
                throw new Error("Authorization 格式无效。请使用: Authorization: Bearer <token1[,token2,...]>");
            }
            if (error === "empty_authorization_tokens") {
                throw new Error("Authorization 中未包含有效 token。请使用: Authorization: Bearer <token1[,token2,...]>");
            }
            if (error === "invalid_x_region") {
                throw new Error("X-Region 无效。仅支持: cn/us/hk/jp/sg");
            }
            if (error === "missing_region") {
                throw new Error("缺少 region。Authorization 中的 token 未在 pool 注册时，请提供 X-Region");
            }
            if (tokens.length === 0) throw new Error("无可用token。请传入 Authorization，或先向 token pool 添加带 region 的 token。");
            const credits = await Promise.all(tokens.map(async (token) => {
                const currentCredit = await getCredit(token.token, token.region);
                if (currentCredit.totalCredit <= 0) {
                    try {
                        await receiveCredit(token.token, token.region);
                        const updatedCredit = await getCredit(token.token, token.region);
                        return {
                            token: token.token,
                            credits: updatedCredit,
                            received: true
                        }
                    } catch (err) {
                        logger.warn('收取积分失败:', err);
                        return {
                            token: token.token,
                            credits: currentCredit,
                            received: false,
                            error: err.message
                        }
                    }
                }
                return {
                    token: token.token,
                    credits: currentCredit,
                    received: false
                }
            }))
            return credits;
        },

        '/pool/add': async (request: Request) => {
            const tokens = parseBodyTokens(request.body.tokens);
            if (tokens.length === 0) throw new Error("body.tokens 不能为空，支持 string 或 string[]");
            const regionCode = parseRegionCode(request.body.region);
            const result = await tokenPool.addTokens(tokens as any, { defaultRegion: regionCode || undefined });
            return {
                ...result,
                summary: tokenPool.getSummary()
            };
        },

        '/pool/remove': async (request: Request) => {
            const tokens = parseBodyTokens(request.body.tokens)
                .map((item) => _.isString(item) ? item : item.token)
                .filter(Boolean);
            if (tokens.length === 0) throw new Error("body.tokens 不能为空，支持 string 或 string[]");
            const result = await tokenPool.removeTokens(tokens);
            return {
                ...result,
                summary: tokenPool.getSummary()
            };
        },

        '/pool/enable': async (request: Request) => {
            request.validate('body.token', _.isString);
            const updated = await tokenPool.setTokenEnabled(request.body.token, true);
            return {
                updated,
                summary: tokenPool.getSummary()
            };
        },

        '/pool/disable': async (request: Request) => {
            request.validate('body.token', _.isString);
            const updated = await tokenPool.setTokenEnabled(request.body.token, false);
            return {
                updated,
                summary: tokenPool.getSummary()
            };
        },

        '/pool/check': async () => {
            const result = await tokenPool.runHealthCheck();
            return {
                ...result,
                summary: tokenPool.getSummary()
            };
        },

        '/pool/reload': async () => {
            await tokenPool.reloadFromDisk();
            return {
                reloaded: true,
                summary: tokenPool.getSummary(),
                items: tokenPool.getEntries(true)
            };
        }

    }

}
