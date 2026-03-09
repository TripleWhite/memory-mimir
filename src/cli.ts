#!/usr/bin/env node
/**
 * memory-mimir CLI — standalone installer for OpenClaw.
 *
 * Usage:
 *   npx memory-mimir init          # register device + install plugin + write config
 *   npx memory-mimir init --url X  # custom Mimir server
 *   npx memory-mimir setup --api-key sk-mimir-xxx  # use existing API key
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { MimirClient } from "./mimir-client.js";

const DEFAULT_URL = "https://api.allinmimir.com";

function parseArgs(argv: string[]): {
  command: string;
  url: string;
  apiKey: string;
  code: string;
} {
  const args = argv.slice(2); // skip node + script
  const command = args[0] ?? "init";
  let url = DEFAULT_URL;
  let apiKey = "";
  let code = "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i];
    } else if (
      (args[i] === "--api-key" || args[i] === "--apiKey") &&
      args[i + 1]
    ) {
      apiKey = args[++i];
    } else if (args[i] === "--code" && args[i + 1]) {
      code = args[++i];
    }
  }

  return { command, url, apiKey, code };
}

function readConfig(configPath: string): Record<string, unknown> {
  try {
    const data = fs.readFileSync(configPath, "utf8");
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(
  configPath: string,
  apiKey: string,
  mimirUrl: string,
): void {
  const ocConfig = readConfig(configPath);

  const plugins = (ocConfig.plugins as Record<string, unknown>) ?? {};
  const entries = (plugins.entries as Record<string, unknown>) ?? {};
  const existing = (entries["memory-mimir"] as Record<string, unknown>) ?? {};
  const pluginCfg = (existing.config as Record<string, unknown>) ?? {};
  const slots = (plugins.slots as Record<string, unknown>) ?? {};

  // Only add to allow list if it already exists — creating one restricts other plugins
  const existingAllow = plugins.allow as string[] | undefined;
  const allowPatch: Record<string, unknown> = {};
  if (Array.isArray(existingAllow)) {
    const filtered = existingAllow.filter((x: string) => x !== "memory-mimir");
    allowPatch.allow = [...filtered, "memory-mimir"];
  }

  const updatedConfig = {
    ...ocConfig,
    plugins: {
      ...plugins,
      enabled: true,
      slots: { ...slots, memory: "memory-mimir" },
      entries: {
        ...entries,
        "memory-mimir": {
          ...existing,
          enabled: true,
          config: {
            ...pluginCfg,
            apiKey,
            mimirUrl,
            autoRecall: true,
            autoCapture: true,
          },
        },
      },
      ...allowPatch,
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
}

function installPlugin(): boolean {
  console.log("\x1b[2m  Installing memory-mimir plugin...\x1b[0m");
  try {
    execSync("openclaw plugins install memory-mimir", {
      stdio: "inherit",
      timeout: 60_000,
    });
    return true;
  } catch {
    console.log(
      "\x1b[33m  ⚠ 'openclaw plugins install' failed or not available.\x1b[0m",
    );
    console.log(
      "\x1b[2m    Config will still be written — install the plugin manually if needed.\x1b[0m",
    );
    return false;
  }
}

function promptForCode(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve("");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      "\x1b[1m  Enter invite code (or press Enter to skip): \x1b[0m",
      (answer) => {
        rl.close();
        resolve(answer.trim());
      },
    );
  });
}

async function cmdInit(url: string, code: string): Promise<void> {
  console.log();
  console.log("\x1b[1m  Mimir Memory — Setup\x1b[0m");
  console.log("\x1b[2m  ─────────────────────────────────\x1b[0m");
  console.log();

  // If no code provided, prompt interactively
  if (!code) {
    code = await promptForCode();
  }

  if (!code) {
    // User pressed Enter without code — show help
    console.log(`
  \x1b[33m  Mimir is currently in closed beta.\x1b[0m

  \x1b[2m  To get started:\x1b[0m
  \x1b[2m    1. Get an invite code from an existing Mimir user\x1b[0m
  \x1b[2m    2. Or register at https://www.allinmimir.com\x1b[0m

  \x1b[2m  Then run:\x1b[0m
  \x1b[1m    npx memory-mimir init --code YOUR_CODE\x1b[0m

  \x1b[2m  Already have an API key?\x1b[0m
  \x1b[1m    npx memory-mimir setup --api-key sk-mimir-xxx\x1b[0m
`);
    process.exit(0);
  }

  // Validate format client-side
  code = code.toUpperCase().trim();

  console.log("\x1b[2m  Validating invite code...\x1b[0m");
  const client = new MimirClient({ url });

  let deviceData: {
    device_key: string;
    pairing_code?: string;
    memory_user_id?: string;
    is_recovery?: boolean;
  };

  try {
    deviceData = await client.deviceInit({ inviteCode: code });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      console.error(
        "\x1b[31m  ✗ Invalid invite code. Please check and try again.\x1b[0m",
      );
    } else if (msg.includes("expired")) {
      console.error("\x1b[31m  ✗ This invite code has expired.\x1b[0m");
    } else if (msg.includes("maximum devices")) {
      console.error(
        "\x1b[31m  ✗ Maximum devices reached for this invite code (limit: 3).\x1b[0m",
      );
      console.error(
        "\x1b[2m    Revoke an old device at https://www.allinmimir.com/dashboard\x1b[0m",
      );
    } else {
      console.error(`\x1b[31m  ✗ Failed to activate: ${msg}\x1b[0m`);
    }
    process.exit(1);
  }

  // Install plugin (best-effort)
  installPlugin();

  // Write config
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  writeConfig(configPath, deviceData.device_key, url);

  if (deviceData.is_recovery) {
    console.log(`
  \x1b[1;32m✅ Account recovered! Memories restored.\x1b[0m
  \x1b[2m─────────────────────────────────────────\x1b[0m
  \x1b[2m  Memory ID:  ${deviceData.memory_user_id}\x1b[0m
  \x1b[2m  Server:     ${url}\x1b[0m
  \x1b[2m  Config:     ${configPath}\x1b[0m

  \x1b[1m  Restart OpenClaw to reconnect to your memories.\x1b[0m
`);
  } else {
    console.log(`
  \x1b[1;32m✅ Mimir activated! Memory engine online.\x1b[0m
  \x1b[2m─────────────────────────────────────────\x1b[0m
  \x1b[2m  Memory ID:  ${deviceData.memory_user_id}\x1b[0m
  \x1b[2m  Server:     ${url}\x1b[0m
  \x1b[2m  Config:     ${configPath}\x1b[0m

  \x1b[1m  Restart OpenClaw to start building memories.\x1b[0m

  \x1b[2;3m  💡 Save your invite code — use it to recover your account on any device.\x1b[0m
`);
  }
}

async function cmdSetup(url: string, apiKey: string): Promise<void> {
  if (!apiKey) {
    console.error("Error: --api-key is required.");
    console.error("  Usage: npx memory-mimir setup --api-key sk-mimir-xxx");
    console.error("  Or run: npx memory-mimir init  (for zero-config setup)");
    process.exit(1);
  }

  console.log();
  console.log("\x1b[2m  Validating API key...\x1b[0m");

  const client = new MimirClient({ url, apiKey });
  let identity: { user_id: string; group_id: string; display_name: string };
  try {
    identity = await client.me();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m  ✗ Authentication failed: ${msg}\x1b[0m`);
    process.exit(1);
  }

  // Install plugin (best-effort)
  installPlugin();

  // Write config
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  writeConfig(configPath, apiKey, url);

  console.log();
  console.log(
    `  \x1b[1;32m✓ Authenticated as: ${identity.display_name}\x1b[0m`,
  );
  console.log(`  \x1b[2mUser ID:   ${identity.user_id}\x1b[0m`);
  console.log(`  \x1b[2mServer:    ${url}\x1b[0m`);
  console.log(`  \x1b[2mConfig:    ${configPath}\x1b[0m`);
  console.log();
  console.log(`  \x1b[1mRestart OpenClaw to activate memory-mimir.\x1b[0m`);
  console.log();
}

async function main(): Promise<void> {
  const { command, url, apiKey, code } = parseArgs(process.argv);

  switch (command) {
    case "init":
      await cmdInit(url, code);
      break;
    case "setup":
      await cmdSetup(url, apiKey);
      break;
    default:
      console.log("Usage:");
      console.log(
        "  npx memory-mimir init --code CODE  # activate with invite code",
      );
      console.log("  npx memory-mimir init              # interactive setup");
      console.log(
        "  npx memory-mimir setup --api-key X  # use existing API key",
      );
      console.log("  npx memory-mimir init --url X       # custom server");
      process.exit(0);
  }
}

main().catch((err) => {
  console.error(`\x1b[31m  Fatal: ${String(err)}\x1b[0m`);
  process.exit(1);
});
