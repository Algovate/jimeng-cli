import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { access, readFile } from "node:fs/promises";

import minimist from "minimist";

import {
  buildRegionInfo,
  getCredit,
  getTokenLiveStatus,
  receiveCredit,
  type RegionCode
} from "@/api/controllers/core.ts";
import tokenPool from "@/lib/session-pool.ts";
import { maskToken } from "@/lib/util.ts";

type JsonRecord = Record<string, unknown>;
type CliHandler = (argv: string[]) => Promise<void>;
type UsageSection = { title: string; lines: string[] };

export type TokenSubcommandName =
  | "list"
  | "check"
  | "points"
  | "receive"
  | "add"
  | "remove"
  | "enable"
  | "disable"
  | "pool"
  | "pool-check"
  | "pool-reload";

export type TokenSubcommandDef = {
  name: TokenSubcommandName;
  description: string;
  usageLine: string;
  options: string[];
  sections?: UsageSection[];
  handler: CliHandler;
};

type TokenCommandDeps = {
  getUsage: (name: TokenSubcommandName) => string;
  getSingleString: (args: Record<string, unknown>, key: string) => string | undefined;
  getRegionWithDefault: (args: Record<string, unknown>) => string;
  toStringList: (raw: unknown) => string[];
  parseRegionOrFail: (region: string | undefined) => RegionCode | undefined;
  ensureTokenPoolReady: () => Promise<void>;
  fail: (message: string) => never;
  failWithUsage: (reason: string, usage: string) => never;
  printJson: (value: unknown) => void;
  printCommandJson: (command: string, data: unknown, meta?: JsonRecord) => void;
  unwrapBody: (payload: unknown) => unknown;
  jsonOption: string;
  helpOption: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUnixMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toISOString();
}

function printTokenEntriesTable(items: unknown[]): void {
  if (items.length === 0) {
    console.log("(empty)");
    return;
  }
  console.log("token\tregion\tenabled\tlive\tlastCredit\tlastCheckedAt\tfailures");
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const e = item as JsonRecord;
    const token = typeof e.token === "string" ? e.token : "-";
    const region = typeof e.region === "string" ? e.region : "-";
    const enabled = typeof e.enabled === "boolean" ? String(e.enabled) : "-";
    const live = typeof e.live === "boolean" ? String(e.live) : "-";
    const lastCredit = typeof e.lastCredit === "number" ? String(e.lastCredit) : "-";
    const lastCheckedAt = formatUnixMs(e.lastCheckedAt);
    const failures = typeof e.consecutiveFailures === "number" ? String(e.consecutiveFailures) : "-";
    console.log(`${token}\t${region}\t${enabled}\t${live}\t${lastCredit}\t${lastCheckedAt}\t${failures}`);
  }
}

function buildTokenPoolSnapshot(): { summary: unknown; items: unknown[] } {
  return {
    summary: tokenPool.getSummary(),
    items: tokenPool.getEntries(true),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTokensFromFile(filePathArg: string, deps: Pick<TokenCommandDeps, "fail">): Promise<string[]> {
  const filePath = path.resolve(filePathArg);
  if (!(await pathExists(filePath))) {
    deps.fail(`Token file not found: ${filePath}`);
  }
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function collectTokensFromArgs(
  args: Record<string, unknown>,
  usage: string,
  deps: Pick<TokenCommandDeps, "toStringList" | "getSingleString" | "fail">,
  required = false
): Promise<string[]> {
  const tokens = [...deps.toStringList(args.token)];
  const tokenFile = deps.getSingleString(args, "token-file");
  if (tokenFile) {
    tokens.push(...(await readTokensFromFile(tokenFile, deps)));
  }
  const deduped = Array.from(new Set(tokens));
  if (required && deduped.length === 0) {
    deps.fail(`No tokens provided.\n\n${usage}`);
  }
  return deduped;
}

/**
 * Resolve explicit tokens + their regions, or fall back to pool entries.
 *
 * Priority:
 *  1. If explicit tokens given via --token / --token-file, resolve region
 *     from --region flag or the token's pool entry.
 *  2. Otherwise, use enabled+live pool entries, optionally filtered by --region.
 */
function resolveTokenRegionPairs(
  explicitTokens: string[],
  regionCode: RegionCode | undefined,
  deps: Pick<TokenCommandDeps, "fail">,
  opts?: { requireLive?: boolean }
): Array<{ token: string; region: RegionCode }> {
  if (explicitTokens.length > 0) {
    return explicitTokens.map((token) => {
      const entryRegion = tokenPool.getTokenEntry(token)?.region;
      const finalRegion = regionCode || entryRegion;
      if (!finalRegion) {
        deps.fail(`Missing region for token ${maskToken(token)}. Provide --region or register token in token-pool.`);
      }
      return { token, region: finalRegion };
    });
  }

  const requireLive = opts?.requireLive ?? true;
  const entries = tokenPool.getEntries(false).filter((item) => {
    if (!item.enabled || !item.region) return false;
    if (requireLive && item.live === false) return false;
    if (regionCode && item.region !== regionCode) return false;
    return true;
  });

  if (entries.length === 0) {
    deps.fail("No token available. Provide --token or configure token-pool.");
  }

  return entries.map((item) => ({ token: item.token, region: item.region as RegionCode }));
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export function createTokenSubcommands(deps: TokenCommandDeps): TokenSubcommandDef[] {
  const handleTokenCheck: CliHandler = async (argv) => {
    const args = minimist(argv, {
      string: ["token", "token-file", "region"],
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage("check");
    if (args.help) {
      console.log(usage);
      return;
    }

    const explicitRegion = deps.getSingleString(args, "region");
    const regionCode = explicitRegion ? deps.parseRegionOrFail(explicitRegion) : undefined;

    await deps.ensureTokenPoolReady();

    const explicitTokens = await collectTokensFromArgs(args, usage, deps, false);
    // check defaults to all enabled tokens (not just live), so requireLive=false
    const pairs = resolveTokenRegionPairs(explicitTokens, regionCode, deps, { requireLive: false });

    if (!args.json) {
      console.log(`Checking ${pairs.length} token(s)`);
    }

    let invalid = 0;
    let requestErrors = 0;
    const results: Array<{ token_masked: string; region: string; live?: boolean; error?: string }> = [];

    for (const { token, region } of pairs) {
      const masked = maskToken(token);
      try {
        const live = await getTokenLiveStatus(token, buildRegionInfo(region));
        await tokenPool.syncTokenCheckResult(token, live);
        if (live) {
          if (!args.json) console.log(`[OK]   ${masked} (${region}) live=true`);
          results.push({ token_masked: masked, region, live: true });
        } else {
          invalid += 1;
          if (!args.json) console.log(`[FAIL] ${masked} (${region}) live=false`);
          results.push({ token_masked: masked, region, live: false });
        }
      } catch (error) {
        requestErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (!args.json) console.log(`[ERROR] ${masked} (${region}) ${message}`);
        results.push({ token_masked: masked, region, error: message });
      }
    }

    if (args.json) {
      deps.printCommandJson("token.check", results, {
        total: pairs.length,
        invalid,
        request_errors: requestErrors,
      });
    } else {
      console.log(`Summary: total=${pairs.length} invalid=${invalid} request_errors=${requestErrors}`);
    }
    if (requestErrors > 0) process.exit(3);
    if (invalid > 0) process.exit(2);
  };

  const handleTokenList: CliHandler = async (argv) => {
    const args = minimist(argv, { boolean: ["help", "json"] });
    if (args.help) {
      console.log(deps.getUsage("list"));
      return;
    }
    await deps.ensureTokenPoolReady();
    const snapshot = buildTokenPoolSnapshot();
    if (args.json) {
      deps.printCommandJson("token.list", snapshot);
      return;
    }
    const body = (snapshot && typeof snapshot === "object" ? snapshot : {}) as JsonRecord;
    if (body.summary && typeof body.summary === "object") {
      console.log("Summary:");
      deps.printJson(body.summary);
    }
    console.log("Entries:");
    printTokenEntriesTable(Array.isArray(body.items) ? body.items : []);
  };

  const handleTokenPointsOrReceive = async (argv: string[], action: "points" | "receive"): Promise<void> => {
    const args = minimist(argv, {
      string: ["token", "token-file", "region"],
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage(action);
    if (args.help) {
      console.log(usage);
      return;
    }

    const regionArg = deps.getSingleString(args, "region");
    const regionCode = regionArg ? deps.parseRegionOrFail(regionArg) : undefined;
    await deps.ensureTokenPoolReady();

    const explicitTokens = await collectTokensFromArgs(args, usage, deps, false);
    const pairs = resolveTokenRegionPairs(explicitTokens, regionCode, deps);

    const toErrorResult = (token: string, region: RegionCode, error: unknown) => ({
      token, region, error: error instanceof Error ? error.message : String(error),
    });

    type ResultBase = { token: string; region: RegionCode };
    type ErrorResult = ResultBase & { error: string };
    type CreditResult = ResultBase & { points: Awaited<ReturnType<typeof getCredit>> };
    type ReceiveResult = ResultBase & { credits: Awaited<ReturnType<typeof getCredit>>; received: boolean } & Partial<ErrorResult>;

    const fetchPoints = async ({ token, region }: { token: string; region: RegionCode }): Promise<CreditResult | ErrorResult> => {
      try {
        return { token, region, points: await getCredit(token, buildRegionInfo(region)) };
      } catch (error) {
        return toErrorResult(token, region, error);
      }
    };

    const processReceive = async ({ token, region }: { token: string; region: RegionCode }): Promise<ReceiveResult | ErrorResult> => {
      const regionInfo = buildRegionInfo(region);
      try {
        const currentCredit = await getCredit(token, regionInfo);
        if (currentCredit.totalCredit > 0) {
          return { token, region, credits: currentCredit, received: false };
        }
        try {
          await receiveCredit(token, regionInfo);
          const updatedCredit = await getCredit(token, regionInfo);
          return { token, region, credits: updatedCredit, received: true };
        } catch (error) {
          return { token, region, credits: currentCredit, received: false, ...toErrorResult(token, region, error) };
        }
      } catch (error) {
        return toErrorResult(token, region, error);
      }
    };

    const payload = action === "points"
      ? await Promise.all(pairs.map(fetchPoints))
      : await Promise.all(pairs.map(processReceive));

    if (args.json) {
      deps.printCommandJson(`token.${action}`, payload);
      return;
    }
    deps.printJson(payload);
  };

  const handleTokenAddOrRemove = async (argv: string[], action: "add" | "remove"): Promise<void> => {
    const args = minimist(argv, {
      string: ["token", "token-file", "region"],
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage(action);
    if (args.help) {
      console.log(usage);
      return;
    }

    await deps.ensureTokenPoolReady();
    const tokens = await collectTokensFromArgs(args, usage, deps, true);

    let payload: Record<string, unknown>;
    let jsonMeta: JsonRecord | undefined;

    if (action === "add") {
      const region = deps.getRegionWithDefault(args);
      const regionCode = deps.parseRegionOrFail(region);
      payload = {
        ...(await tokenPool.addTokens(tokens, { defaultRegion: regionCode || undefined })),
        summary: tokenPool.getSummary(),
      };
      jsonMeta = { region };
    } else {
      payload = {
        ...(await tokenPool.removeTokens(tokens)),
        summary: tokenPool.getSummary(),
      };
    }

    if (args.json) {
      deps.printCommandJson(`token.${action}`, deps.unwrapBody(payload), jsonMeta);
      return;
    }
    deps.printJson(deps.unwrapBody(payload));
  };

  const handleTokenEnableOrDisable = async (argv: string[], action: "enable" | "disable"): Promise<void> => {
    const args = minimist(argv, { string: ["token"], boolean: ["help", "json"] });
    const usage = deps.getUsage(action);
    if (args.help) {
      console.log(usage);
      return;
    }
    const token = deps.getSingleString(args, "token");
    if (!token) {
      deps.failWithUsage("Missing required --token.", usage);
    }
    await deps.ensureTokenPoolReady();
    const payload = {
      updated: await tokenPool.setTokenEnabled(token, action === "enable"),
      summary: tokenPool.getSummary(),
    };
    if (args.json) {
      deps.printCommandJson(`token.${action}`, deps.unwrapBody(payload));
      return;
    }
    deps.printJson(deps.unwrapBody(payload));
  };

  const handleTokenPool: CliHandler = async (argv) => {
    const args = minimist(argv, { boolean: ["help", "json"] });
    if (args.help) {
      console.log(deps.getUsage("pool"));
      return;
    }
    await deps.ensureTokenPoolReady();
    const snapshot = buildTokenPoolSnapshot();
    if (args.json) {
      deps.printCommandJson("token.pool", snapshot);
      return;
    }
    const body = (snapshot && typeof snapshot === "object" ? snapshot : {}) as JsonRecord;
    console.log("Summary:");
    deps.printJson(body.summary ?? {});
    console.log("Entries:");
    printTokenEntriesTable(Array.isArray(body.items) ? body.items : []);
  };

  const handleTokenPoolCheckOrReload = async (argv: string[], action: "pool-check" | "pool-reload"): Promise<void> => {
    const args = minimist(argv, { boolean: ["help", "json"] });
    if (args.help) {
      console.log(deps.getUsage(action));
      return;
    }
    await deps.ensureTokenPoolReady();
    let payload;
    if (action === "pool-check") {
      payload = { ...(await tokenPool.runHealthCheck()), summary: tokenPool.getSummary() };
    } else {
      tokenPool.reloadFromDisk();
      payload = { reloaded: true, summary: tokenPool.getSummary(), items: buildTokenPoolSnapshot().items };
    }
    if (args.json) {
      deps.printCommandJson(`token.${action}`, deps.unwrapBody(payload));
      return;
    }
    deps.printJson(deps.unwrapBody(payload));
  };

  return [
    {
      name: "list",
      description: "List token pool entries",
      usageLine: "  jimeng token list [options]",
      options: [deps.jsonOption, deps.helpOption],
      handler: handleTokenList,
    },
    {
      name: "check",
      description: "Validate tokens",
      usageLine: "  jimeng token check [options]",
      options: [
        "  --token <token>          Token, can be repeated (default: all enabled tokens)",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        Override region (default: token's registered region)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: handleTokenCheck,
    },
    {
      name: "points",
      description: "Query token points",
      usageLine: "  jimeng token points [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        Filter tokens by region (cn/us/hk/jp/sg)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: async (argv) => handleTokenPointsOrReceive(argv, "points"),
    },
    {
      name: "receive",
      description: "Receive token credits",
      usageLine: "  jimeng token receive [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        Filter tokens by region (cn/us/hk/jp/sg)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: async (argv) => handleTokenPointsOrReceive(argv, "receive"),
    },
    {
      name: "add",
      description: "Add token(s) into token-pool",
      usageLine: "  jimeng token add --token <token> [--token <token> ...] [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        Region for add, default cn (cn/us/hk/jp/sg)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: async (argv) => handleTokenAddOrRemove(argv, "add"),
    },
    {
      name: "remove",
      description: "Remove token(s) from token-pool",
      usageLine: "  jimeng token remove --token <token> [--token <token> ...] [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: async (argv) => handleTokenAddOrRemove(argv, "remove"),
    },
    {
      name: "enable",
      description: "Enable one token in token-pool",
      usageLine: "  jimeng token enable --token <token> [options]",
      options: ["  --token <token>          Required, a single token", deps.jsonOption, deps.helpOption],
      handler: async (argv) => handleTokenEnableOrDisable(argv, "enable"),
    },
    {
      name: "disable",
      description: "Disable one token in token-pool",
      usageLine: "  jimeng token disable --token <token> [options]",
      options: ["  --token <token>          Required, a single token", deps.jsonOption, deps.helpOption],
      handler: async (argv) => handleTokenEnableOrDisable(argv, "disable"),
    },
    {
      name: "pool",
      description: "Show token-pool summary and entries",
      usageLine: "  jimeng token pool [options]",
      options: [deps.jsonOption, deps.helpOption],
      handler: handleTokenPool,
    },
    {
      name: "pool-check",
      description: "Trigger token-pool health check",
      usageLine: "  jimeng token pool-check [options]",
      options: [deps.jsonOption, deps.helpOption],
      handler: async (argv) => handleTokenPoolCheckOrReload(argv, "pool-check"),
    },
    {
      name: "pool-reload",
      description: "Reload token-pool from disk",
      usageLine: "  jimeng token pool-reload [options]",
      options: [deps.jsonOption, deps.helpOption],
      handler: async (argv) => handleTokenPoolCheckOrReload(argv, "pool-reload"),
    },
  ];
}
