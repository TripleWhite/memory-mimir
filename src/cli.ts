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
import { execSync } from "node:child_process";
import { MimirClient } from "./mimir-client.js";

const DEFAULT_URL = "https://api.allinmimir.com";

function parseArgs(argv: string[]): {
  command: string;
  url: string;
  apiKey: string;
} {
  const args = argv.slice(2); // skip node + script
  const command = args[0] ?? "init";
  let url = DEFAULT_URL;
  let apiKey = "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i];
    } else if (
      (args[i] === "--api-key" || args[i] === "--apiKey") &&
      args[i + 1]
    ) {
      apiKey = args[++i];
    }
  }

  return { command, url, apiKey };
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

async function cmdInit(url: string): Promise<void> {
  console.log();
  console.log("\x1b[1m  Mimir Memory — Zero-Config Setup\x1b[0m");
  console.log("\x1b[2m  ─────────────────────────────────\x1b[0m");
  console.log();

  // 1. Register device
  console.log("\x1b[2m  Connecting to Mimir gateway...\x1b[0m");
  const client = new MimirClient({ url });
  let deviceData: { device_key: string; pairing_code: string };
  try {
    deviceData = await client.deviceInit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m  ✗ Mimir gateway unreachable: ${msg}\x1b[0m`);
    console.error(
      `\x1b[2m    Check your network or try: npx memory-mimir init --url <server-url>\x1b[0m`,
    );
    process.exit(1);
  }

  // 2. Install plugin via openclaw CLI (best-effort)
  installPlugin();

  // 3. Write config
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  writeConfig(configPath, deviceData.device_key, url);

  // 4. Success
  console.log(`
  \x1b[1;32m✅ Mimir activated! Memory engine online.\x1b[0m
  \x1b[2m─────────────────────────────────────────\x1b[0m
  \x1b[2m🔒 Anonymous channel assigned. Config written to openclaw.json.\x1b[0m
  \x1b[2m💡 Restart OpenClaw — memories will upload in sandbox mode.\x1b[0m

  \x1b[1m🌐 To manage your AI memory graph on the web:\x1b[0m
  \x1b[34m🔗 1. Open: https://www.allinmimir.com/dashboard\x1b[0m
  \x1b[1;35m🔑 2. Enter pairing code: \x1b[43;30m ${deviceData.pairing_code} \x1b[0m

  \x1b[2;3m(Skip this to stay in permanent anonymous sandbox mode)\x1b[0m
`);
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
  const { command, url, apiKey } = parseArgs(process.argv);

  switch (command) {
    case "init":
      await cmdInit(url);
      break;
    case "setup":
      await cmdSetup(url, apiKey);
      break;
    default:
      console.log("Usage:");
      console.log("  npx memory-mimir init              # zero-config setup");
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
