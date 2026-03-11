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
import { fileURLToPath } from "node:url";
import { MimirClient } from "./mimir-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, "..");

const DEFAULT_URL = "https://api.allinmimir.com";

function parseArgs(argv: string[]): {
  command: string;
  url: string;
  apiKey: string;
  code: string;
  skipVerify: boolean;
} {
  const args = argv.slice(2); // skip node + script
  const command = args[0] ?? "init";
  let url = DEFAULT_URL;
  let apiKey = "";
  let code = "";
  let skipVerify = false;

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
    } else if (args[i] === "--skip-verify") {
      skipVerify = true;
    }
  }

  return { command, url, apiKey, code, skipVerify };
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
  You have tools to search deeper and store important facts — use them proactively and silently.
---

# Mimir Memory — Behavioral Guide

## Core Principle

You have long-term memory. Use it naturally. From the user's perspective, you simply **remember** — never mention tool names, never say "let me search my memory", never expose the mechanics.

---

## 1. Reading Your Memories

Before each conversation, a \\\`<memories>\\\` block may appear with auto-recalled context. Understand its scope:

**What auto-recall covers:**
- Factual records (event_log): things the user did, said, decided
- Known entities: people, places, projects the user mentioned
- Relationships: how entities connect to each other

**What auto-recall does NOT cover:**
- Full conversation summaries (episodes) — it never searches these
- Raw documents — it never searches these
- Predictions/plans (foresights) — it never searches these

**How auto-recall constructs its query:**
- Short messages (≤100 chars): uses the user's exact words
- Long messages (>100 chars): extracts up to 8 English keywords, or first 200 chars for Chinese/Japanese/Korean
- Basic time keywords (昨天, last week, 上个月, etc.) are auto-detected and used as filters

**What this means for you:**
- If the user asks a simple factual question and \\\`<memories>\\\` has the answer → just answer
- If the user references a past conversation or wants a summary → \\\`<memories>\\\` won't have it, you need to search
- If the user's message is long/complex → keyword extraction may have missed key terms, consider searching with a focused query
- If \\\`<memories>\\\` is empty or doesn't match the question → search proactively

---

## 2. When to Proactively Search

Don't wait for the user to ask you to search. Detect these cues and act silently:

### Must search (auto-recall can't help)

| Pattern | Why | How to search |
|---------|-----|---------------|
| "总结一下我们上次讨论的..." / "summarize what we talked about..." | Needs conversation summaries | \\\`memory_types: ["episode"]\\\` |
| "我之前发给你的那个文档..." / "that document I shared..." | Needs raw documents | \\\`memory_types: ["raw_doc"]\\\` |
| References a complex relationship chain | Auto-recall uses fast search without graph traversal | Search without type filter for broadest coverage |

### Should search (auto-recall likely insufficient)

| Pattern | Why | How to search |
|---------|-----|---------------|
| \\\`<memories>\\\` present but doesn't answer the question | Query keywords didn't match | Rephrase with more specific terms |
| "跟我说说关于 X 的所有事" / "tell me everything about X" | Needs multiple types | Omit memory_types for broadest results |
| "具体是哪天..." / "exactly when did..." | Needs precise time filtering | Use explicit \\\`start_time\\\`/\\\`end_time\\\` in ISO 8601 |
| User mentions a person + context auto-recall missed | Auto-recall limited to 12 items | Search with \\\`memory_types: ["entity", "relation"]\\\` and the person's name |

### Don't search (auto-recall is enough)

- \\\`<memories>\\\` already contains the answer
- User is asking about something new (not past conversations)
- User is giving you new information, not asking about old

### Query construction tips

Extract the core topic from the user's message — don't pass their full sentence:

\\\`\\\`\\\`
User: "还记得上次我跟你说我想换工作的事吗"
→ query: "换工作 职业规划"

User: "我跟 Caroline 上周讨论的那个设计方案怎么样了"
→ query: "Caroline 设计方案"

User: "what did we decide about the API rate limiting?"
→ query: "API rate limiting decision"
\\\`\\\`\\\`

Include: names, dates, topic keywords.
Avoid: filler words, full sentences, vague references like "that thing".

### Time filtering

Auto-recall already detects basic patterns (yesterday, 上周, last month). But for precise control:

| User says | start_time | end_time |
|-----------|-----------|---------|
| "三月份的" | 2026-03-01T00:00:00Z | 2026-03-31T23:59:59Z |
| "去年夏天" | 2025-06-01T00:00:00Z | 2025-09-01T00:00:00Z |
| "最近三天" | (3 days ago) | (now) |

### memory_types reference

| Type | Contains | When to use |
|------|----------|-------------|
| \\\`event_log\\\` | Atomic facts, decisions, events with timestamps | "What did I eat Tuesday?" |
| \\\`entity\\\` | People, places, projects, concepts | "Who is Caroline?" |
| \\\`relation\\\` | How entities connect | "How do Arthur and Caroline know each other?" |
| \\\`episode\\\` | Full conversation summaries | "Summarize our Chrome extension discussion" |
| \\\`raw_doc\\\` | Documents the user shared | "That PDF I sent you" |
| \\\`foresight\\\` | Plans, predictions, future intentions | "What did I plan for next quarter?" |

---

## 3. When to Store

**After each conversation, the full dialogue is automatically saved.** You don't need to store what was already said.

Use explicit storage ONLY for:

- **User explicitly asks**: "记住我不喝咖啡" / "remember I'm allergic to shellfish"
- **Critical atomic facts** that might get buried in a long conversation: a decision, a deadline, a preference

Rules:
- One fact per store call
- Include the person's name: "Arthur prefers dark roast coffee" not "prefers dark roast coffee"
- Don't store things the user just said (auto-capture will save the full conversation)
- Don't store facts already present in \\\`<memories>\\\`
- Don't ask "should I remember this?" — if it's clearly important, just store it

---

## 4. First Conversation (Onboarding)

If no \\\`<memories>\\\` block is present, the user just installed Mimir. Welcome them:

---
记忆已就绪！我现在可以跨对话记住你告诉我的事情了。

试试看：
- **介绍自己** — 告诉我你的名字、职业、兴趣，我会记住
- **让我记住什么** — 比如"记住我喜欢深色模式"
- **下次对话验证** — 重启后问"你还记得我吗？"

你聊天的重要内容我也会自动捕捉，不用每次都说"记住"。
---

Match the user's language. Keep it short. Do NOT repeat onboarding in later conversations where \\\`<memories>\\\` is present.

---

## 5. Using \\\`<memories>\\\` Naturally

- Weave memories into your response — don't list them like a database query result
- If the answer is in \\\`<memories>\\\`, just answer directly — never say "based on my memory records" or "I found in my memory"
- If \\\`<memories>\\\` conflicts with what the user just said, **trust the user** — they may have changed their mind
- If \\\`<memories>\\\` is insufficient, search deeper **silently**, then answer

---

## 6. Anti-patterns

| Never do this | Do this instead |
|---------------|-----------------|
| "让我搜索一下记忆..." | Silently search, then answer |
| "根据我的记忆数据库..." | "你之前提过..." or just answer directly |
| "I'll use mimir_search to find that" | Just find it and answer |
| "I found 5 results matching your query" | Synthesize the results into a natural answer |
| Store every single thing the user says | Let auto-capture handle it |
| "Do you want me to remember that?" | If it's important, just remember |
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

    // Copy node_modules/ (runtime dependencies)
    const nmSrc = path.join(PACKAGE_ROOT, "node_modules");
    if (fs.existsSync(nmSrc)) {
      fs.cpSync(nmSrc, path.join(extensionDir, "node_modules"), {
        recursive: true,
      });
    }

    return true;
  } catch {
    return false;
  }
}

function printSuccess(): void {
  console.log(`
  ✅ Memory activated! Restart OpenClaw to start.

  After restart, try:
  - Introduce yourself (name, job, interests) — I'll remember
  - Say "remember I prefer dark mode" — saves to memory
  - Next session, ask "do you remember me?" — verifies it works

  Chat normally — important details are captured automatically.
`);
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
  // If no code provided, prompt interactively
  if (!code) {
    code = await promptForCode();
  }

  if (!code) {
    console.log(`
  Mimir is in closed beta. You need an invite code to get started.
  Get one at: https://www.allinmimir.com

  Usage: npx memory-mimir init --code XXXXXX
`);
    process.exit(1);
  }

  code = code.toUpperCase().trim();
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
      console.error("\n  ✗ Invalid invite code.\n");
    } else if (msg.includes("expired")) {
      console.error("\n  ✗ Invite code expired.\n");
    } else if (msg.includes("already activated")) {
      console.error(
        "\n  ✗ This invite code was already used. Add new devices via Dashboard → API key.\n",
      );
    } else if (msg.includes("maximum devices")) {
      console.error(
        "\n  ✗ Maximum devices reached. Add new devices via Dashboard → API key.\n",
      );
    } else {
      console.error(`\n  ✗ ${msg}\n`);
    }
    process.exit(1);
  }

  installPlugin();
  installSkill();
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  writeConfig(configPath, deviceData.device_key, url);

  printSuccess();
}

async function cmdSetup(
  url: string,
  apiKey: string,
  skipVerify: boolean,
): Promise<void> {
  if (!apiKey) {
    console.log(`
  Usage: npx memory-mimir setup --api-key sk-mimir-xxx
`);
    process.exit(1);
  }

  if (!skipVerify) {
    const client = new MimirClient({ url, apiKey });
    try {
      await client.me();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Invalid API key: ${msg}\n`);
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
  const { command, url, apiKey, code, skipVerify } = parseArgs(process.argv);

  switch (command) {
    case "init":
      await cmdInit(url, code);
      break;
    case "setup":
      await cmdSetup(url, apiKey, skipVerify);
      break;
    case "install":
      installPlugin();
      installSkill();
      break;
    default:
      console.log("Usage:");
      console.log(
        "  npx memory-mimir init --code CODE   # activate with invite code",
      );
      console.log("  npx memory-mimir init               # interactive setup");
      console.log(
        "  npx memory-mimir setup --api-key X  # use existing API key",
      );
      console.log(
        "  npx memory-mimir install            # install plugin + skill only",
      );
      process.exit(0);
  }
}

main().catch((err) => {
  console.error(`\x1b[31m  Fatal: ${String(err)}\x1b[0m`);
  process.exit(1);
});
