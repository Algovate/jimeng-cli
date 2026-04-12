import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import minimist from "minimist";

import {
  buildRegionInfo,
  getCredit,
  type RegionCode
} from "@/api/controllers/core.ts";
import tokenPool from "@/lib/session-pool.ts";

type JsonRecord = Record<string, unknown>;

type LoginDeps = {
  getSingleString: (args: Record<string, unknown>, key: string) => string | undefined;
  getRegionWithDefault: (args: Record<string, unknown>) => string;
  parseRegionOrFail: (region: string | undefined) => RegionCode | undefined;
  ensureTokenPoolReady: () => Promise<void>;
  fail: (message: string) => never;
  printJson: (value: unknown) => void;
  printCommandJson: (command: string, data: unknown, meta?: JsonRecord) => void;
};

// import.meta.url is only available in ESM; LOGIN_SCRIPT is resolved from the bundled dist/ directory.
const LOGIN_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "scripts", "jimeng_login_helper.py",
);

/**
 * Create the login command handler.
 * The login flow:
 * 1. Try to use the bundled Python login helper (jimeng_login.py via CDP)
 * 2. Fall back to manual sessionid input
 * 3. Auto-add the token to the token pool
 */
export function createLoginCommandHandler(deps: LoginDeps): (argv: string[]) => Promise<void> {
  return async (argv: string[]): Promise<void> => {
    const args = minimist(argv, {
      string: ["region", "sessionid", "debug-port"],
      boolean: ["help", "headless", "json"],
    });

    if (args.help) {
      console.log(usageLogin());
      return;
    }

    const region = deps.getRegionWithDefault(args);
    const parsedRegion = deps.parseRegionOrFail(region);
    const isJson = Boolean(args.json);
    const sessionid = deps.getSingleString(args, "sessionid");
    const debugPort = deps.getSingleString(args, "debug-port") || "9333";
    const headless = Boolean(args.headless);

    // Mode 1: Direct sessionid provided via --sessionid
    if (sessionid) {
      await addSessionToPool(sessionid, parsedRegion || "cn", deps, isJson);
      return;
    }

    // Mode 2: Try Python login helper (CDP-based browser login)
    const pythonLoginResult = await tryPythonLogin(debugPort, headless);
    if (pythonLoginResult) {
      await addSessionToPool(pythonLoginResult, parsedRegion || "cn", deps, isJson);
      return;
    }

    // Mode 3: Fallback - manual sessionid input
    console.log("");
    console.log("Auto login not available. Please provide your sessionid manually.");
    console.log("You can get it from:");
    console.log("  1. Login at https://jimeng.jianying.com/ai-tool/home/");
    console.log("  2. Open DevTools > Application > Cookies > sessionid");
    console.log("");
    console.log("Then run: jimeng login --sessionid <your_sessionid> --region cn");
    console.log("");
    console.log("Or install Python 3 to use the automatic browser login.");
  };
};

async function tryPythonLogin(debugPort: string, headless: boolean): Promise<string | null> {
  // Check if Python login script exists
  const loginScript = findLoginScript();
  if (!loginScript) {
    return null;
  }

  console.log(`Launching browser login (debug port: ${debugPort})...`);
  console.log("Please complete login in the Chrome window.\n");

  try {
    const cmdArgs = [loginScript, "--debug-port", debugPort];
    if (headless) cmdArgs.push("--headless");

    const result = await runPythonScript(cmdArgs);
    const output = result.stdout.trim();

    // Parse sessionid from output (format: "  sessionid: xxxxxxxx")
    const match = output.match(/sessionid:\s*(\S+)/);
    if (match) {
      return match[1];
    }

    console.log("Login script completed but sessionid not found in output.");
    return null;
  } catch (error: any) {
    console.log(`Auto login failed: ${error.message}`);
    return null;
  }
}

function findLoginScript(): string | null {
  // Check bundled location first
  if (existsSync(LOGIN_SCRIPT)) {
    return LOGIN_SCRIPT;
  }

  // Check common locations
  const candidates = [
    path.join(process.cwd(), "jimeng_login.py"),
    path.join(os.homedir(), ".jimeng_login.py"),
  ];

  // Check if python3 can find it in PATH
  try {
    const whichResult = execSync("which jimeng_login.py 2>/dev/null || echo ''", { encoding: "utf-8" }).trim();
    if (whichResult) return whichResult;
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function runPythonScript(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const proc = spawn(pythonCmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Stream output to console
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        console.log(line);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Login script exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to run login script: ${error.message}`));
    });
  });
}

async function addSessionToPool(
  sessionid: string,
  region: RegionCode,
  deps: LoginDeps,
  isJson: boolean
): Promise<void> {
  await deps.ensureTokenPoolReady();

  const { added, total } = await tokenPool.addTokens([sessionid], { defaultRegion: region });

  if (added > 0) {
    const masked = sessionid.length > 10
      ? `${sessionid.slice(0, 4)}...${sessionid.slice(-4)}`
      : "***";

    // Try to verify the token by checking credits
    let creditInfo = "";
    try {
      const { totalCredit } = await getCredit(sessionid, buildRegionInfo(region));
      creditInfo = ` (credits: ${totalCredit})`;
    } catch {
      creditInfo = " (credit check failed)";
    }

    if (isJson) {
      deps.printCommandJson("login", {
        token: masked,
        region,
        added: true,
        total,
        creditCheck: creditInfo.trim(),
      });
    } else {
      console.log(`\nLogin successful!`);
      console.log(`  Token: ${masked}`);
      console.log(`  Region: ${region}${creditInfo}`);
      console.log(`  Pool size: ${total} token(s)`);
    }
  } else {
    if (isJson) {
      deps.printCommandJson("login", {
        added: false,
        total,
        reason: "token already exists in pool",
      });
    } else {
      console.log(`Token already exists in pool. Pool size: ${total} token(s)`);
    }
  }
}

function usageLogin(): string {
  return [
    "Usage:",
    "  jimeng login [options]",
    "",
    "Options:",
    "  --region <region>        Region for the token (default cn)",
    "  --sessionid <token>      Add sessionid directly (skip browser login)",
    "  --debug-port <port>      Chrome debug port (default 9333)",
    "  --headless              Run Chrome in headless mode",
    "  --json                   Output structured JSON",
    "  --help                   Show help",
    "",
    "Notes:",
    "  - Without --sessionid, launches Chrome for browser login (requires Python 3).",
    "  - With --sessionid, directly adds the token to the pool.",
    "  - After login, the token is automatically added to the token pool.",
    "  - Token is validated by checking credit balance.",
  ].join("\n");
}
