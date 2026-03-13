#!/usr/bin/env node
/**
 * memory-mimir CLI — standalone installer for OpenClaw.
 *
 * Usage:
 *   npx memory-mimir setup --api-key sk-mimir-xxx  # install with API key
 *   npx memory-mimir install                       # install plugin files only
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MimirClient } from "./mimir-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..");

const DEFAULT_URL = "https://api.allinmimir.com";
const SIGNUP_URL = "https://www.allinmimir.com";

function parseArgs(argv: string[]): {
  command: string;
  url: string;
  apiKey: string;
  skipVerify: boolean;
} {
  const args = argv.slice(2); // skip node + script
  const command = args[0] ?? "";
  let url = DEFAULT_URL;
  let apiKey = "";
  let skipVerify = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[++i];
    } else if (
      (args[i] === "--api-key" || args[i] === "--apiKey") &&
      args[i + 1]
    ) {
      apiKey = args[++i];
    } else if (args[i] === "--skip-verify") {
      skipVerify = true;
    }
  }

  return { command, url, apiKey, skipVerify };
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

const SKILL_MD = `---
name: mimir-memory
description: >
  Long-term memory powered by Mimir. You can remember across conversations.
  A <memories> block is automatically injected before each conversation with relevant context.
---

# Mimir Memory — Behavioral Guide

## Core Principle

You have long-term memory. Use it naturally. From the user's perspective, you simply **remember** — never mention tools, never say "let me search my memory", never expose the mechanics.

---

## 1. How Memory Works

Before each conversation, a \\\`<memories>\\\` block is automatically injected with relevant context. This uses full search (keyword + semantic + graph traversal) to find the most relevant memories.

**What auto-recall retrieves:**
- Factual records (event_log): things the user did, said, decided
- Known entities: people, places, projects the user mentioned
- Relationships: how entities connect to each other

**How auto-recall constructs its query:**
- Short messages (≤100 chars): uses the user's exact words
- Long messages (>100 chars): extracts up to 8 English keywords, or first 200 chars for Chinese/Japanese/Korean
- Time keywords (昨天, last week, 上个月, etc.) are auto-detected and used as time filters

---

## 2. Answering with Memories

- If \\\`<memories>\\\` has the answer → just answer directly
- If \\\`<memories>\\\` is empty or doesn't match → say you don't recall, or ask the user for more context
- Weave memories into your response naturally — don't list them like database results
- Never say "based on my memory records" or "I found in my memory" — just answer as if you remember
- If \\\`<memories>\\\` conflicts with what the user just said, **trust the user** — they may have changed their mind

---

## 3. How Storage Works

**All conversations are automatically captured** — every message is sent to Mimir for extraction (entities, events, relations) after each agent turn. There is no manual store tool.

When the user says "记住..." / "remember...":
- Acknowledge naturally ("好的" / "Got it")
- The fact will be captured automatically from the conversation
- Do NOT say "I've saved that to memory" or imply a special action was taken — it's the same auto-capture process

---

## 3. First Conversation (Onboarding)

If no \\\`<memories>\\\` block is present, the user just installed Mimir. Welcome them:

---
记忆已就绪！我现在可以跨对话记住你告诉我的事情了。

试试看：
- **介绍自己** — 告诉我你的名字、职业、兴趣
- **正常聊天** — 重要的内容会自动被记住
- **下次对话验证** — 重启后问"你还记得我吗？"
---

Match the user's language. Keep it short. Do NOT repeat onboarding in later conversations where \\\`<memories>\\\` is present.

---

## 4. Anti-patterns

| Never do this | Do this instead |
|---------------|-----------------|
| "让我搜索一下记忆..." | Just answer from \\\`<memories>\\\` |
| "根据我的记忆数据库..." | "你之前提过..." or just answer directly |
| "I found 5 results matching your query" | Synthesize into a natural answer |
| "I've saved that to my memory" | Just acknowledge ("好的") — auto-capture handles it |
| "Do you want me to remember that?" | Don't ask — everything is captured automatically |
| Show raw memory entries to the user | Paraphrase and integrate naturally |
`;

function installSkill(): boolean {
  try {
    const skillDir = path.join(
      os.homedir(),
      ".openclaw",
      "skills",
      "memory-mimir",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_MD);

    // Clean up legacy mimir-skill directory (from old npx skills add TripleWhite/mimir-skill)
    const legacySkillDir = path.join(
      os.homedir(),
      ".openclaw",
      "skills",
      "mimir-skill",
    );
    if (fs.existsSync(legacySkillDir)) {
      fs.rmSync(legacySkillDir, { recursive: true });
    }

    return true;
  } catch {
    return false;
  }
}

function installPlugin(): boolean {
  try {
    const extensionDir = path.join(
      os.homedir(),
      ".openclaw",
      "extensions",
      "memory-mimir",
    );

    // Clean previous install
    if (fs.existsSync(extensionDir)) {
      fs.rmSync(extensionDir, { recursive: true });
    }
    fs.mkdirSync(extensionDir, { recursive: true });

    // Copy dist/
    fs.cpSync(
      path.join(PACKAGE_ROOT, "dist"),
      path.join(extensionDir, "dist"),
      { recursive: true },
    );

    // Copy manifest + package.json
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, "openclaw.plugin.json"),
      path.join(extensionDir, "openclaw.plugin.json"),
    );
    fs.copyFileSync(
      path.join(PACKAGE_ROOT, "package.json"),
      path.join(extensionDir, "package.json"),
    );

    // Copy skills/ (plugin-contributed SKILL.md for persistent discovery)
    const skillsSrc = path.join(PACKAGE_ROOT, "skills");
    if (fs.existsSync(skillsSrc)) {
      fs.cpSync(skillsSrc, path.join(extensionDir, "skills"), {
        recursive: true,
      });
    }

    // Install runtime dependencies in extension dir
    // (copying node_modules from npx cache is unreliable — deps may be hoisted)
    try {
      execSync("npm install --omit=dev --ignore-scripts", {
        cwd: extensionDir,
        stdio: "ignore",
        timeout: 30_000,
      });
    } catch {
      // Fallback: try copying from package root (works for local dev)
      const nmSrc = path.join(PACKAGE_ROOT, "node_modules");
      if (fs.existsSync(nmSrc)) {
        fs.cpSync(nmSrc, path.join(extensionDir, "node_modules"), {
          recursive: true,
        });
      }
    }

    return true;
  } catch {
    return false;
  }
}

function printSuccess(): void {
  console.log(`
  ✅ Memory activated! Restart your AI agent to start.

  After restart, try:
  - Introduce yourself (name, job, interests)
  - Chat normally — important details are captured automatically
  - Next session, ask "do you remember me?" to verify

  Upgrading? Old plugin files and skills have been replaced.
`);
}

function printUsage(): void {
  console.log(`
  Mimir — Long-term memory for your AI agent.

  Usage:
    npx memory-mimir setup --api-key <KEY>   Install with API key
    npx memory-mimir install                 Install plugin files only

  Get your API key at: ${SIGNUP_URL}
`);
}

async function cmdSetup(
  url: string,
  apiKey: string,
  skipVerify: boolean,
): Promise<void> {
  if (!apiKey) {
    console.log(`
  ✗ API key required.

  Get your API key at: ${SIGNUP_URL}
  Then run: npx memory-mimir setup --api-key <YOUR_KEY>
`);
    process.exit(1);
  }

  if (!skipVerify) {
    const client = new MimirClient({ url, apiKey });
    try {
      await client.me();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Invalid API key: ${msg}`);
      console.error(`  Get a valid key at: ${SIGNUP_URL}\n`);
      process.exit(1);
    }
  }

  installPlugin();
  installSkill();
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  writeConfig(configPath, apiKey, url);

  printSuccess();
}

async function main(): Promise<void> {
  const { command, url, apiKey, skipVerify } = parseArgs(process.argv);

  switch (command) {
    case "setup":
      await cmdSetup(url, apiKey, skipVerify);
      break;
    case "install":
      installPlugin();
      installSkill();
      console.log("\n  ✅ Plugin files installed.\n");
      break;
    default:
      printUsage();
      process.exit(0);
  }
}

main().catch((err) => {
  console.error(`\x1b[31m  Fatal: ${String(err)}\x1b[0m`);
  process.exit(1);
});
