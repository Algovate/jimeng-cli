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

function maskToken(token: string): string {
  const n = token.length;
  if (n <= 10) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

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
    const entry = item as JsonRecord;
    const token = typeof entry.token === "string" ? entry.token : "-";
    const region = typeof entry.region === "string" ? entry.region : "-";
    const enabled = typeof entry.enabled === "boolean" ? String(entry.enabled) : "-";
    const live = typeof entry.live === "boolean" ? String(entry.live) : "-";
    const lastCredit = typeof entry.lastCredit === "number" ? String(entry.lastCredit) : "-";
    const lastCheckedAt = formatUnixMs(entry.lastCheckedAt);
    const failures =
      typeof entry.consecutiveFailures === "number" ? String(entry.consecutiveFailures) : "-";
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
    const region = deps.getRegionWithDefault(args);
    const regionCode = deps.parseRegionOrFail(region);
    if (!regionCode) {
      deps.fail("Missing region. Use --region cn/us/hk/jp/sg.");
    }
    const tokens = await collectTokensFromArgs(args, usage, deps, true);
    if (!args.json) {
      console.log(`Checking ${tokens.length} token(s)`);
    }

    await deps.ensureTokenPoolReady();
    let invalid = 0;
    let requestErrors = 0;
    const results: Array<{ token_masked: string; live?: boolean; error?: string }> = [];
    for (const token of tokens) {
      const masked = maskToken(token);
      try {
        const live = await getTokenLiveStatus(token, buildRegionInfo(regionCode));
        await tokenPool.syncTokenCheckResult(token, live);
        if (live === true) {
          if (!args.json) console.log(`[OK]   ${masked} live=true`);
        } else {
          invalid += 1;
          if (!args.json) console.log(`[FAIL] ${masked} live=false`);
        }
        results.push({ token_masked: masked, live: live === true });
      } catch (error) {
        requestErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (!args.json) console.log(`[ERROR] ${masked} ${message}`);
        results.push({ token_masked: masked, error: message });
      }
    }
    if (args.json) {
      deps.printCommandJson("token.check", results, {
        total: tokens.length,
        invalid,
        request_errors: requestErrors,
      });
    } else {
      console.log(`Summary: total=${tokens.length} invalid=${invalid} request_errors=${requestErrors}`);
    }
    if (requestErrors > 0) process.exit(3);
    if (invalid > 0) process.exit(2);
  };

  const handleTokenList: CliHandler = async (argv) => {
    const args = minimist(argv, {
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage("list");
    if (args.help) {
      console.log(usage);
      return;
    }
    await deps.ensureTokenPoolReady();
    const normalized = buildTokenPoolSnapshot();
    if (args.json) {
      deps.printCommandJson("token.list", normalized);
      return;
    }
    const body = normalized && typeof normalized === "object" ? (normalized as JsonRecord) : {};
    const summary = body.summary;
    if (summary && typeof summary === "object") {
      console.log("Summary:");
      deps.printJson(summary);
    }
    const items = Array.isArray(body.items) ? body.items : [];
    console.log("Entries:");
    printTokenEntriesTable(items);
  };

  const handleTokenPointsOrReceive = async (
    argv: string[],
    action: "points" | "receive"
  ): Promise<void> => {
    const args = minimist(argv, {
      string: ["token", "token-file", "region"],
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage(action);
    if (args.help) {
      console.log(usage);
      return;
    }
    const region = deps.getRegionWithDefault(args);
    const regionCode = deps.parseRegionOrFail(region);
    await deps.ensureTokenPoolReady();
    const tokens = await collectTokensFromArgs(args, usage, deps, false);
    const resolvedTokens = tokens.length > 0
      ? tokens.map((token) => {
          const entryRegion = tokenPool.getTokenEntry(token)?.region;
          const finalRegion = regionCode || entryRegion;
          if (!finalRegion) {
            deps.fail(`Missing region for token ${maskToken(token)}. Provide --region or register token region in token-pool.`);
          }
          return { token, region: finalRegion };
        })
      : tokenPool.getEntries(false)
          .filter((item) => item.enabled && item.live !== false && item.region)
          .filter((item) => (regionCode ? item.region === regionCode : true))
          .map((item) => ({ token: item.token, region: item.region! }));
    if (resolvedTokens.length === 0) {
      deps.fail("No token available. Provide --token or configure token-pool.");
    }
    const payload = action === "points"
      ? await Promise.all(
          resolvedTokens.map(async (item) => ({
            token: item.token,
            points: await getCredit(item.token, buildRegionInfo(item.region)),
          }))
        )
      : await Promise.all(
          resolvedTokens.map(async (item) => {
            const currentCredit = await getCredit(item.token, buildRegionInfo(item.region));
            if (currentCredit.totalCredit <= 0) {
              try {
                await receiveCredit(item.token, buildRegionInfo(item.region));
                const updatedCredit = await getCredit(item.token, buildRegionInfo(item.region));
                return { token: item.token, credits: updatedCredit, received: true };
              } catch (error: any) {
                return {
                  token: item.token,
                  credits: currentCredit,
                  received: false,
                  error: error?.message || String(error),
                };
              }
            }
            return { token: item.token, credits: currentCredit, received: false };
          })
        );
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
    const region = deps.getRegionWithDefault(args);
    await deps.ensureTokenPoolReady();
    const tokens = await collectTokensFromArgs(args, usage, deps, true);
    const regionCode = deps.parseRegionOrFail(region);
    const payload = action === "add"
      ? {
          ...(await tokenPool.addTokens(tokens, { defaultRegion: regionCode || undefined })),
          summary: tokenPool.getSummary(),
        }
      : {
          ...(await tokenPool.removeTokens(tokens)),
          summary: tokenPool.getSummary(),
        };
    if (args.json) {
      deps.printCommandJson(`token.${action}`, deps.unwrapBody(payload), { region });
      return;
    }
    deps.printJson(deps.unwrapBody(payload));
  };

  const handleTokenEnableOrDisable = async (argv: string[], action: "enable" | "disable"): Promise<void> => {
    const args = minimist(argv, {
      string: ["token"],
      boolean: ["help", "json"],
    });
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
    const args = minimist(argv, {
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage("pool");
    if (args.help) {
      console.log(usage);
      return;
    }
    await deps.ensureTokenPoolReady();
    const normalized = buildTokenPoolSnapshot();
    if (args.json) {
      deps.printCommandJson("token.pool", normalized);
      return;
    }
    const body = normalized && typeof normalized === "object" ? (normalized as JsonRecord) : {};
    console.log("Summary:");
    deps.printJson(body.summary ?? {});
    console.log("Entries:");
    printTokenEntriesTable(Array.isArray(body.items) ? body.items : []);
  };

  const handleTokenPoolCheckOrReload = async (
    argv: string[],
    action: "pool-check" | "pool-reload"
  ): Promise<void> => {
    const args = minimist(argv, {
      boolean: ["help", "json"],
    });
    const usage = deps.getUsage(action);
    if (args.help) {
      console.log(usage);
      return;
    }
    await deps.ensureTokenPoolReady();
    const payload = action === "pool-check"
      ? {
          ...(await tokenPool.runHealthCheck()),
          summary: tokenPool.getSummary(),
        }
      : (await tokenPool.reloadFromDisk(), {
          reloaded: true,
          summary: tokenPool.getSummary(),
          items: buildTokenPoolSnapshot().items,
        });
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
      description: "Validate tokens directly",
      usageLine: "  jimeng token check --token <token> [--token <token> ...] [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        X-Region, default cn (cn/us/hk/jp/sg)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: handleTokenCheck,
    },
    {
      name: "points",
      description: "Query token points directly",
      usageLine: "  jimeng token points [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        Filter tokens by X-Region, default cn (cn/us/hk/jp/sg)",
        deps.jsonOption,
        deps.helpOption,
      ],
      handler: async (argv) => handleTokenPointsOrReceive(argv, "points"),
    },
    {
      name: "receive",
      description: "Receive token credits directly",
      usageLine: "  jimeng token receive [options]",
      options: [
        "  --token <token>          Token, can be repeated",
        "  --token-file <path>      Read tokens from file (one per line, # for comments)",
        "  --region <region>        Filter tokens by X-Region, default cn (cn/us/hk/jp/sg)",
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
