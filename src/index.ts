/**
 * memory-mimir: OpenClaw plugin entry point.
 *
 * Replaces OpenClaw's built-in file-backed memory with Mimir
 * as a full long-term memory backend (graph + vector + BM25).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MimirClient, MimirError } from "./mimir-client.js";
import { formatSearchResults } from "./formatter.js";
import { migrate, hasExistingData, hasLocalMemories } from "./migration.js";

// ─── Capture state persistence (survives process restarts) ──

interface CaptureState {
  /** SHA-256 hashes (truncated to 16 hex chars) of already-ingested messages. */
  ingestedHashes: string[];
}

const CAPTURE_STATE_DIR = path.join(os.homedir(), ".openclaw");
const CAPTURE_STATE_FILE = path.join(
  CAPTURE_STATE_DIR,
  "memory-mimir-capture.json",
);

function loadCaptureState(): CaptureState {
  try {
    const data = fs.readFileSync(CAPTURE_STATE_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed.ingestedHashes)) {
      return { ingestedHashes: parsed.ingestedHashes as string[] };
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh.
  }
  return { ingestedHashes: [] };
}

function saveCaptureState(state: CaptureState): void {
  try {
    fs.mkdirSync(CAPTURE_STATE_DIR, { recursive: true });
    fs.writeFileSync(CAPTURE_STATE_FILE, JSON.stringify(state));
  } catch {
    // Best-effort — don't crash if write fails.
  }
}

/** Stable hash for a parsed message — used to skip already-ingested messages. */
function hashMsg(role: string, content: string): string {
  return crypto
    .createHash("sha256")
    .update(role + "\x00" + content)
    .digest("hex")
    .slice(0, 16);
}

// ─── Types (mirroring OpenClaw plugin-sdk) ──────────────────

interface OpenClawPluginApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  resolvePath: (path: string) => string;
  on: (
    event: string,
    handler: (
      event: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | void>,
  ) => void;
  registerTool: (
    definition: Record<string, unknown>,
    options: { name: string },
  ) => void;
  registerCli: (
    factory: (ctx: { program: CommanderProgram }) => void,
    options: { commands: string[] },
  ) => void;
  registerService: (definition: {
    id: string;
    start: () => void;
    stop: () => void;
  }) => void;
}

interface CommanderProgram {
  command: (name: string) => CommanderCommand;
}

interface CommanderCommand {
  description: (desc: string) => CommanderCommand;
  argument: (name: string, desc: string) => CommanderCommand;
  option: (
    flags: string,
    desc: string,
    defaultVal?: string,
  ) => CommanderCommand;
  action: (fn: (...args: unknown[]) => Promise<void>) => CommanderCommand;
  command: (name: string) => CommanderCommand;
}

// ─── Configuration ──────────────────────────────────────────

interface PluginConfig {
  readonly mimirUrl: string;
  readonly apiKey: string;
  readonly userId: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly autoRecall: boolean;
  readonly autoCapture: boolean;
  readonly maxRecallTokens: number;
  readonly maxRecallItems: number;
}

function resolveConfig(pluginConfig: Record<string, unknown>): PluginConfig {
  return {
    mimirUrl:
      (pluginConfig.mimirUrl as string) ??
      process.env.MIMIR_URL ??
      "https://api.allinmimir.com",
    apiKey: (pluginConfig.apiKey as string) ?? process.env.MIMIR_API_KEY ?? "",
    userId: (pluginConfig.userId as string) ?? process.env.MIMIR_USER_ID ?? "",
    groupId:
      (pluginConfig.groupId as string) ?? process.env.MIMIR_GROUP_ID ?? "",
    displayName:
      (pluginConfig.displayName as string) ??
      process.env.MIMIR_DISPLAY_NAME ??
      "",
    autoRecall:
      (pluginConfig.autoRecall as boolean) ??
      process.env.MIMIR_AUTO_RECALL !== "false",
    autoCapture:
      (pluginConfig.autoCapture as boolean) ??
      process.env.MIMIR_AUTO_CAPTURE !== "false",
    maxRecallTokens: parsePositiveInt(
      pluginConfig.maxRecallTokens as number | undefined,
      800,
    ),
    maxRecallItems: parsePositiveInt(
      pluginConfig.maxRecallItems as number | undefined,
      12,
    ),
  };
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

// ─── Query Preparation ──────────────────────────────────────

/** Detect CJK characters in text. */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(
    text,
  );
}

/**
 * Extract plain text from a message content block (string or array).
 * Handles mixed content: text, tool_use, tool_result, image, document.
 * - text blocks: included as-is
 * - tool_use: "[工具: name(args)]" so we know what was invoked
 * - tool_result: recursively extract text (web fetch results, file reads, etc.)
 * - image: "[图片]" placeholder — OpenClaw's reply will describe it
 * - document: "[文档]" placeholder
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "tool_result":
        // Drop tool results entirely — file contents, command output, search
        // results are noise for memory extraction. The assistant's natural
        // language summary of these results is what matters.
        break;
      case "tool_use":
        // Keep only the tool name for minimal context (e.g. "used Read"),
        // drop args to avoid ingesting file paths, code snippets, etc.
        if (typeof block.name === "string") {
          parts.push(`[used ${block.name}]`);
        }
        break;
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push("[document]");
        break;
    }
  }
  return parts.filter(Boolean).join("\n");
}

/** Attachment extracted from message content blocks. */
interface ExtractedAttachment {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

/**
 * Extract image and document attachments from message content blocks.
 * Handles:
 * - Direct image blocks (source.type === "base64")
 * - Direct document blocks (source.type === "base64")
 * - tool_result blocks containing nested image/document blocks
 */
export function extractAttachments(content: unknown): ExtractedAttachment[] {
  if (!Array.isArray(content)) return [];

  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB per file
  const MAX_ATTACHMENTS = 20; // cap total per message

  const attachments: ExtractedAttachment[] = [];
  let imageCount = 0;
  let docCount = 0;

  function safeExt(mediaType: string, fallback: string): string {
    const raw = mediaType.split("/")[1] || fallback;
    return raw.replace(/[^a-z0-9]/gi, "").slice(0, 10) || fallback;
  }

  function processBlock(block: Record<string, unknown>, depth = 0): void {
    if (!block || typeof block !== "object") return;
    if (attachments.length >= MAX_ATTACHMENTS) return;
    if (depth > 3) return;

    if (block.type === "image") {
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === "base64" && typeof source.data === "string") {
        const estimatedBytes = Math.ceil(
          ((source.data as string).length * 3) / 4,
        );
        if (estimatedBytes > MAX_ATTACHMENT_BYTES) return;
        imageCount++;
        const mediaType = (source.media_type as string) || "image/png";
        attachments.push({
          fileName: `image_${imageCount}.${safeExt(mediaType, "png")}`,
          mimeType: mediaType,
          data: Buffer.from(source.data as string, "base64"),
        });
      }
    }

    if (block.type === "document") {
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === "base64" && typeof source.data === "string") {
        const estimatedBytes = Math.ceil(
          ((source.data as string).length * 3) / 4,
        );
        if (estimatedBytes > MAX_ATTACHMENT_BYTES) return;
        docCount++;
        const mediaType = (source.media_type as string) || "application/pdf";
        attachments.push({
          fileName: `document_${docCount}.${safeExt(mediaType, "pdf")}`,
          mimeType: mediaType,
          data: Buffer.from(source.data as string, "base64"),
        });
      }
    }

    // Recurse into tool_result content
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      for (const nested of block.content as Array<Record<string, unknown>>) {
        processBlock(nested, depth + 1);
      }
    }
  }

  for (const block of content as Array<Record<string, unknown>>) {
    processBlock(block, 0);
  }

  return attachments;
}

/** Prepare query for server-side search — truncate only, no keyword extraction.
 *  Server's BM25 (IDF), vector embedding, and graph traverse handle the rest.
 *  Preserves original casing for entity name matching in graph traverse.
 */
export function extractKeywords(message: string): string {
  if (hasCJK(message)) {
    return message.slice(0, 300).trim();
  }
  // Preserve original case, strip punctuation, compress whitespace
  return message
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ─── Time Range Extraction ───────────────────────────────────

interface TimeRangeResult {
  readonly start: string; // ISO 8601 (e.g. "2026-03-01T00:00:00Z")
  readonly end: string;
}

/** Extract time range from user message using keyword matching.
 *  Returns undefined if no temporal reference is found.
 */
export function extractTimeRange(message: string): TimeRangeResult | undefined {
  const lower = message.toLowerCase();
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );

  const rules: Array<{
    keywords: string[];
    start: Date;
    end: Date;
  }> = [
    {
      keywords: ["yesterday", "昨天"],
      start: addDays(today, -1),
      end: today,
    },
    {
      keywords: ["day before yesterday", "前天"],
      start: addDays(today, -2),
      end: addDays(today, -1),
    },
    {
      keywords: ["last week", "上周", "上个星期"],
      start: addDays(today, -7),
      end: today,
    },
    {
      keywords: ["this week", "这周", "这个星期"],
      start: addDays(today, -today.getUTCDay()),
      end: addDays(today, 1),
    },
    {
      keywords: ["last month", "上个月"],
      start: addMonths(today, -1),
      end: today,
    },
    {
      keywords: ["this month", "这个月"],
      start: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)),
      end: addDays(today, 1),
    },
    {
      keywords: ["last year", "去年"],
      start: addYears(today, -1),
      end: today,
    },
    {
      keywords: ["this year", "今年"],
      start: new Date(Date.UTC(now.getFullYear(), 0, 1)),
      end: addDays(today, 1),
    },
    {
      keywords: ["today", "今天"],
      start: today,
      end: addDays(today, 1),
    },
  ];

  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) {
        return {
          start: rule.start.toISOString(),
          end: rule.end.toISOString(),
        };
      }
    }
  }

  return undefined;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

// ─── No-Key Mode: only register CLI for init/setup ──────────

function registerCliOnly(
  api: OpenClawPluginApi,
  rawCfg: ReturnType<typeof resolveConfig>,
) {
  api.registerCli(
    ({ program }) => {
      const mimir = program
        .command("mimir")
        .description("Mimir memory plugin commands");

      mimir
        .command("init")
        .description(
          "Auto-register anonymous device and configure Mimir (zero-config)",
        )
        .option("--url <url>", "Mimir server URL", "https://api.allinmimir.com")
        .action(async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as Record<string, string>;
          const mimirUrl = opts.url || rawCfg.mimirUrl;

          console.log();
          console.log("\x1b[2m  Connecting to Mimir gateway...\x1b[0m");

          const initClient = new MimirClient({ url: mimirUrl });
          let deviceData: {
            device_key: string;
            pairing_code?: string;
            memory_user_id?: string;
            is_recovery?: boolean;
          };
          try {
            deviceData = await initClient.deviceInit();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `\x1b[31m  ✗ Mimir gateway unreachable: ${msg}\x1b[0m`,
            );
            return;
          }

          const configPath = path.join(
            os.homedir(),
            ".openclaw",
            "openclaw.json",
          );
          let ocConfig: Record<string, unknown> = {};
          try {
            const data = fs.readFileSync(configPath, "utf8");
            ocConfig = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // start fresh
          }

          const plugins = (ocConfig.plugins as Record<string, unknown>) ?? {};
          const entries = (plugins.entries as Record<string, unknown>) ?? {};
          const existing =
            (entries["memory-mimir"] as Record<string, unknown>) ?? {};
          const pluginCfg = (existing.config as Record<string, unknown>) ?? {};
          const slots = (plugins.slots as Record<string, unknown>) ?? {};
          const existingAllow = plugins.allow as string[] | undefined;
          const allowPatch: Record<string, unknown> = {};
          if (Array.isArray(existingAllow)) {
            allowPatch.allow = [
              ...existingAllow.filter((x: string) => x !== "memory-mimir"),
              "memory-mimir",
            ];
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
                    apiKey: deviceData.device_key,
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

          console.log(`
  \x1b[1;32m✅ Mimir activated! Memory engine online.\x1b[0m
  \x1b[2m─────────────────────────────────────────\x1b[0m
  \x1b[2m🔒 Anonymous channel assigned. Config written to openclaw.json.\x1b[0m
  \x1b[2m💡 Restart OpenClaw — memories will upload in sandbox mode.\x1b[0m

  \x1b[1m🌐 To manage your AI memory graph on the web:\x1b[0m
  \x1b[34m🔗 1. Open: https://app.allinmimir.com/dashboard/pair\x1b[0m
  \x1b[1;35m🔑 2. Enter pairing code: \x1b[43;30m ${deviceData.pairing_code} \x1b[0m

  \x1b[2;3m(Skip this to stay in permanent anonymous sandbox mode)\x1b[0m
`);
        });

      mimir
        .command("setup")
        .description("Configure memory-mimir with an existing API key")
        .option("--api-key <key>", "Your Mimir API key (sk-mimir-...)")
        .option("--url <url>", "Mimir server URL", "https://api.allinmimir.com")
        .action(async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as Record<string, string>;
          const apiKey = opts["api-key"] || opts["apiKey"];
          if (!apiKey) {
            console.error("Error: --api-key is required.");
            console.error(
              "  Usage: openclaw mimir setup --api-key sk-mimir-xxx",
            );
            console.error(
              "  Or run: openclaw mimir init  (for zero-config setup)",
            );
            return;
          }
          console.log(
            "Run 'openclaw mimir setup --api-key ...' after the plugin is fully loaded.",
          );
        });
    },
    { commands: ["mimir"] },
  );
}

// ─── Plugin Definition ──────────────────────────────────────

const memoryMimirPlugin = {
  id: "memory-mimir",
  name: "Memory (Mimir)",
  description: "Mimir-powered long-term memory for OpenClaw",
  kind: "memory" as const,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      apiKey: {
        type: "string",
        description:
          "Mimir API key (device key mimir_dev_... or sk-mimir-...). Run 'openclaw mimir init' to get one.",
      },
      mimirUrl: {
        type: "string",
        description: "Mimir server URL (e.g. http://localhost:8766)",
      },
      userId: {
        type: "string",
        description: "User ID for Mimir memory isolation",
      },
      groupId: { type: "string", description: "Group ID for memory scoping" },
      autoRecall: {
        type: "boolean",
        description: "Auto-inject relevant memories before agent starts",
      },
      autoCapture: {
        type: "boolean",
        description: "Auto-capture conversations after agent ends",
      },
      maxRecallItems: {
        type: "number",
        description: "Maximum number of memory items to recall",
      },
      maxRecallTokens: {
        type: "number",
        description: "Maximum tokens for recalled memory context",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const rawCfg = resolveConfig(api.pluginConfig ?? {});

    // If no apiKey configured, register CLI commands only (for 'mimir init')
    if (!rawCfg.apiKey) {
      api.logger.info(
        "memory-mimir: no API key configured. Run 'openclaw mimir init' to set up.",
      );
      registerCliOnly(api, rawCfg);
      return;
    }

    const client = new MimirClient({
      url: rawCfg.mimirUrl,
      apiKey: rawCfg.apiKey,
    });

    // Resolved config — userId/groupId may be filled in after /api/v1/me lookup
    let cfg = rawCfg;

    // If apiKey is set but userId is empty, auto-fetch from /api/v1/me
    if (rawCfg.apiKey && !rawCfg.userId) {
      client
        .me()
        .then((me) => {
          cfg = {
            ...rawCfg,
            userId: me.user_id,
            groupId: me.group_id,
            displayName: me.display_name || rawCfg.displayName,
          };
          api.logger.info(
            `memory-mimir: authenticated as ${me.display_name} (user: ${me.user_id}, server: ${rawCfg.mimirUrl})`,
          );
        })
        .catch((err) => {
          api.logger.warn(
            `memory-mimir: failed to fetch identity from /api/v1/me: ${String(err)}`,
          );
        });
    } else {
      api.logger.info(
        `memory-mimir: registered (user: ${rawCfg.userId}, server: ${rawCfg.mimirUrl})`,
      );
    }

    // ════════════════════════════════════════════════════════
    // Tools
    // ════════════════════════════════════════════════════════

    // memory_search tool: removed — eval shows auto-recall (full) alone is optimal.
    // LLM never calls the tool when auto-recall provides context (72% vs 74%).
    // mimir_store: removed — auto-capture handles storage.
    // mimir_forget: removed — no server-side deletion API yet.

    // ════════════════════════════════════════════════════════
    // CLI Commands
    // ════════════════════════════════════════════════════════

    api.registerCli(
      ({ program }) => {
        const mimir = program
          .command("mimir")
          .description("Mimir memory plugin commands");

        mimir
          .command("init")
          .description(
            "Auto-register anonymous device and configure Mimir (zero-config)",
          )
          .option(
            "--url <url>",
            "Mimir server URL",
            "https://api.allinmimir.com",
          )
          .action(async (...args: unknown[]) => {
            const opts = (args[0] ?? {}) as Record<string, string>;
            const mimirUrl = opts.url || cfg.mimirUrl;

            console.log();
            console.log("\x1b[2m  Connecting to Mimir gateway...\x1b[0m");

            // 1. Call device/init (no auth needed)
            const initClient = new MimirClient({ url: mimirUrl });
            let deviceData: {
              device_key: string;
              pairing_code?: string;
              memory_user_id?: string;
              is_recovery?: boolean;
            };
            try {
              deviceData = await initClient.deviceInit();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `\x1b[31m  ✗ Mimir gateway unreachable: ${msg}\x1b[0m`,
              );
              console.error(
                `\x1b[2m    Check your network or try: --url <server-url>\x1b[0m`,
              );
              return;
            }

            // 2. Patch OpenClaw config
            const configPath = path.join(
              os.homedir(),
              ".openclaw",
              "openclaw.json",
            );
            let ocConfig: Record<string, unknown> = {};
            try {
              const data = fs.readFileSync(configPath, "utf8");
              ocConfig = JSON.parse(data) as Record<string, unknown>;
            } catch {
              // Config doesn't exist — start fresh
            }

            const plugins = (ocConfig.plugins as Record<string, unknown>) ?? {};
            const entries = (plugins.entries as Record<string, unknown>) ?? {};
            const existing =
              (entries["memory-mimir"] as Record<string, unknown>) ?? {};
            const pluginCfg =
              (existing.config as Record<string, unknown>) ?? {};

            const slots = (plugins.slots as Record<string, unknown>) ?? {};
            const existingAllow2 = plugins.allow as string[] | undefined;
            const allowPatch2: Record<string, unknown> = {};
            if (Array.isArray(existingAllow2)) {
              allowPatch2.allow = [
                ...existingAllow2.filter((x: string) => x !== "memory-mimir"),
                "memory-mimir",
              ];
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
                      apiKey: deviceData.device_key,
                      mimirUrl,
                      autoRecall: true,
                      autoCapture: true,
                    },
                  },
                },
                ...allowPatch2,
              },
            };

            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(
              configPath,
              JSON.stringify(updatedConfig, null, 2),
            );

            // 3. Print cyberpunk welcome
            console.log(`
  \x1b[1;32m✅ Mimir Quantum Core activated. Cloud memory grid online.\x1b[0m
  \x1b[2m─────────────────────────────────────────────────────\x1b[0m
  \x1b[2m🔒 Anonymous secure channel assigned. Config injected into openclaw.json.\x1b[0m
  \x1b[2m💡 You can use OpenClaw now — memories upload in sandbox mode.\x1b[0m

  \x1b[1m🌐 Want to visualize and manage your AI memory graph on the web?\x1b[0m
  \x1b[34m🔗 1. Open: https://app.allinmimir.com/dashboard/pair\x1b[0m
  \x1b[1;35m🔑 2. Enter pairing code: \x1b[43;30m ${deviceData.pairing_code} \x1b[0m

  \x1b[2;3m(Tip: Skip this step to stay in permanent anonymous sandbox mode)\x1b[0m
`);
          });

        mimir
          .command("setup")
          .description(
            "Configure memory-mimir with an API key from allinmimir.com",
          )
          .option("--api-key <key>", "Your Mimir API key (sk-mimir-...)")
          .option(
            "--url <url>",
            "Mimir server URL",
            "https://api.allinmimir.com",
          )
          .action(async (...args: unknown[]) => {
            const opts = (args[0] ?? {}) as Record<string, string>;
            const apiKey = opts["api-key"] || opts["apiKey"] || cfg.apiKey;
            const mimirUrl = opts.url || cfg.mimirUrl;

            if (!apiKey) {
              console.error(`Error: --api-key is required.`);
              console.error(
                `  Get your API key at https://allinmimir.com/dashboard`,
              );
              console.error(
                `  Usage: openclaw mimir setup --api-key sk-mimir-xxx`,
              );
              return;
            }

            console.log(`Validating API key...`);
            const tempClient = new MimirClient({ url: mimirUrl, apiKey });

            let identity: {
              user_id: string;
              group_id: string;
              display_name: string;
            };
            try {
              identity = await tempClient.me();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`Error: ${msg}`);
              console.error(
                `  Check your API key or run: openclaw mimir setup --api-key sk-mimir-xxx`,
              );
              return;
            }

            // Write to OpenClaw plugin config
            const configPath = path.join(
              os.homedir(),
              ".openclaw",
              "openclaw.json",
            );
            let ocConfig: Record<string, unknown> = {};
            try {
              const data = fs.readFileSync(configPath, "utf8");
              ocConfig = JSON.parse(data) as Record<string, unknown>;
            } catch {
              // Config doesn't exist yet — start fresh
            }

            const plugins = (ocConfig.plugins as Record<string, unknown>) ?? {};
            const entries = (plugins.entries as Record<string, unknown>) ?? {};
            const existing =
              (entries["memory-mimir"] as Record<string, unknown>) ?? {};
            const pluginCfg =
              (existing.config as Record<string, unknown>) ?? {};
            const slots = (plugins.slots as Record<string, unknown>) ?? {};
            const setupExistingAllow = plugins.allow as string[] | undefined;
            const setupAllowPatch: Record<string, unknown> = {};
            if (Array.isArray(setupExistingAllow)) {
              setupAllowPatch.allow = [
                ...setupExistingAllow.filter(
                  (x: string) => x !== "memory-mimir",
                ),
                "memory-mimir",
              ];
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
                      userId: identity.user_id,
                      groupId: identity.group_id,
                      autoRecall: true,
                      autoCapture: true,
                    },
                  },
                },
                ...setupAllowPatch,
              },
            };

            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(
              configPath,
              JSON.stringify(updatedConfig, null, 2),
            );

            console.log();
            console.log(`✓ Authenticated as: ${identity.display_name}`);
            console.log(`  User ID:   ${identity.user_id}`);
            console.log(`  Server:    ${mimirUrl}`);
            console.log(`  Config:    ${configPath}`);
            console.log();
            console.log(`Restart OpenClaw to activate memory-mimir.`);
          });

        mimir
          .command("migrate")
          .description(
            "Import existing OpenClaw/Claude Code memories into Mimir",
          )
          .argument("[path]", "Override memory directory path")
          .option("--force", "Migrate even if user already has data")
          .option(
            "--background",
            "Run migration in the background (non-blocking)",
          )
          .action(async (...args: unknown[]) => {
            const memoryDir = args[0] as string | undefined;
            const opts = (args[1] ?? {}) as Record<string, unknown>;
            const healthy = await client.health();
            if (!healthy) {
              console.error(
                `Cannot reach Mimir at ${cfg.mimirUrl}. Run "openclaw mimir setup" first.`,
              );
              return;
            }

            const existingData = await hasExistingData(client, cfg.userId);
            if (existingData && !opts.force) {
              console.log(
                `User "${cfg.userId}" already has data in Mimir. Use --force to migrate anyway.`,
              );
              return;
            }

            const runMigration = async () => {
              const result = await migrate(client, {
                userId: cfg.userId,
                groupId: cfg.groupId,
                memoryDir,
                onProgress: (current, total, filename) => {
                  if (opts.background) {
                    api.logger.info(
                      `memory-mimir: migrating ${current}/${total}: ${filename}`,
                    );
                  } else {
                    console.log(`Migrating ${current}/${total}: ${filename}`);
                  }
                },
              });

              const summary =
                `Migration: ${result.filesIngested}/${result.filesFound} files, ` +
                `${result.totalEpisodes} episodes, ${result.totalEntities} entities`;

              if (opts.background) {
                api.logger.info(`memory-mimir: ${summary}`);
                if (result.errors.length > 0) {
                  api.logger.warn(
                    `memory-mimir: migration errors: ${result.errors.join(", ")}`,
                  );
                }
              } else {
                console.log(`\nMigration Complete`);
                console.log(`─────────────────`);
                console.log(`Files found:    ${result.filesFound}`);
                console.log(`Files ingested: ${result.filesIngested}`);
                console.log(`Files failed:   ${result.filesFailed}`);
                console.log(`Episodes:       ${result.totalEpisodes}`);
                console.log(`Entities:       ${result.totalEntities}`);
                console.log(`Relations:      ${result.totalRelations}`);

                if (result.errors.length > 0) {
                  console.log(`\nErrors:`);
                  for (const err of result.errors) {
                    console.log(`  - ${err}`);
                  }
                }
              }

              return result;
            };

            if (opts.background) {
              console.log(
                "Migration started in background. Check logs for progress.",
              );
              // Fire and forget — don't await
              runMigration().catch((err) => {
                api.logger.error(
                  `memory-mimir: background migration failed: ${String(err)}`,
                );
              });
            } else {
              await runMigration();
            }
          });

        mimir
          .command("search")
          .description("Search Mimir memory from the terminal")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .action(async (...actionArgs: unknown[]) => {
            const query = actionArgs[0] as string;
            const opts = (actionArgs[1] ?? {}) as Record<string, unknown>;
            try {
              const results = await client.search(cfg.userId, query, {
                groupId: cfg.groupId,
                topK: parseInt(opts.limit as string, 10) || 10,
              });

              if (results.results.length === 0) {
                console.log("No results found.");
                return;
              }

              console.log(
                formatSearchResults(results, { maxItems: 10, maxChars: 4000 }),
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`Search failed: ${msg}`);
            }
          });

        mimir
          .command("status")
          .description("Show Mimir connection status and memory statistics")
          .action(async () => {
            const healthy = await client.health();
            console.log(`Connection: ${healthy ? "OK" : "FAILED"}`);

            if (!healthy) {
              console.log(`Cannot reach ${cfg.mimirUrl}`);
              return;
            }

            try {
              const episodeSearch = await client.search(cfg.userId, "*", {
                groupId: cfg.groupId,
                memoryTypes: ["episode"],
                topK: 1,
              });
              const entitySearch = await client.search(cfg.userId, "*", {
                groupId: cfg.groupId,
                memoryTypes: ["entity"],
                topK: 1,
              });

              console.log(`User:       ${cfg.userId}`);
              console.log(
                `Episodes:   ${episodeSearch.results.length > 0 ? "present" : "none"}`,
              );
              console.log(
                `Entities:   ${entitySearch.results.length > 0 ? "present" : "none"}`,
              );

              const localMemories = await hasLocalMemories();
              if (localMemories) {
                console.log();
                console.log(
                  `Local memory files found. Run "openclaw mimir migrate" to import them.`,
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(`Stats unavailable: ${msg}`);
            }
          });
      },
      { commands: ["mimir"] },
    );

    // ════════════════════════════════════════════════════════
    // Lifecycle Hooks
    // ════════════════════════════════════════════════════════

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        const prompt = event.prompt as string | undefined;
        if (!prompt || prompt.length < 5) return;

        try {
          const query = extractKeywords(prompt);
          if (!query) return;

          api.logger.info(
            `memory-mimir: recall query="${query.slice(0, 80)}" (prompt ${prompt.length} chars)`,
          );

          const timeRange = extractTimeRange(prompt);

          const RECALL_TIMEOUT_MS = 5_000;
          const results = await Promise.race([
            client.search(cfg.userId, query, {
              groupId: cfg.groupId,
              topK: 15,
              retrieveMethod: "full",
              memoryTypes: ["event_log", "entity", "relation"],
              startTime: timeRange?.start,
              endTime: timeRange?.end,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("recall timeout")),
                RECALL_TIMEOUT_MS,
              ),
            ),
          ]);

          if (results.results.length === 0) {
            api.logger.info(
              `memory-mimir: no memories found (query: ${query.slice(0, 60)})`,
            );
            return;
          }

          api.logger.info(
            `memory-mimir: injecting ${results.results.length} memories into context`,
          );

          const formatted = formatSearchResults(results, {
            maxItems: cfg.maxRecallItems,
            maxChars: cfg.maxRecallTokens * 4,
          });

          return {
            prependContext: `<memories>\n${formatted}\n</memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-mimir: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: ingest conversation to Mimir after agent ends.
    // Uses per-message content hashing to track what has already been ingested,
    // so restarts and session compaction never cause re-ingestion or missed messages.
    if (cfg.autoCapture) {
      const CONTEXT_WINDOW = 4; // preceding (already-ingested) messages for LLM context
      const savedState = loadCaptureState();
      const ingestedHashes = new Set<string>(savedState.ingestedHashes);

      api.on("agent_end", async (event) => {
        const messages = event.messages as
          | Array<Record<string, unknown>>
          | undefined;
        if (!messages || messages.length === 0) return;

        try {
          const allParsed: Array<{
            role: "user" | "assistant";
            sender_name: string;
            content: string;
            hash: string;
          }> = [];

          for (const msg of messages) {
            if (!msg || typeof msg !== "object") continue;
            const role = msg.role as string;
            if (role !== "user" && role !== "assistant") continue;
            const content = extractMessageText(msg.content);
            if (!content || content.includes("<memories>")) continue;
            // Skip system-injected content (XML tags from hooks, reminders, etc.)
            if (
              /^<(system-reminder|memories|relevant-memories)>/i.test(
                content.trim(),
              )
            )
              continue;
            // Skip messages that are only tool markers with no real text,
            // e.g. "[used Read]\n[used Edit]" — no knowledge to extract.
            if (/^\s*(\[(used \w+|image|document)\]\s*)+$/.test(content))
              continue;
            allParsed.push({
              role: role as "user" | "assistant",
              sender_name:
                role === "user" ? cfg.displayName || cfg.userId : "assistant",
              content,
              hash: hashMsg(role, content),
            });
          }

          if (allParsed.length === 0) return;

          api.logger.info(
            `memory-mimir: session-end parsed=${allParsed.length}`,
          );

          // Find the first new (not yet ingested) message.
          const firstNewIdx = allParsed.findIndex(
            (m) => !ingestedHashes.has(m.hash),
          );
          if (firstNewIdx === -1) return; // all already ingested

          // Include CONTEXT_WINDOW already-ingested messages for LLM context.
          const contextStart = Math.max(0, firstNewIdx - CONTEXT_WINDOW);
          const toSend = allParsed.slice(contextStart);
          const newCount = allParsed.length - firstNewIdx;

          // Mark only the new messages as ingested.
          for (let i = firstNewIdx; i < allParsed.length; i++) {
            ingestedHashes.add(allParsed[i].hash);
          }
          // Cap stored hashes to prevent unbounded growth — keep most recent.
          const MAX_HASHES = 5000;
          const hashArr = [...ingestedHashes];
          const trimmed =
            hashArr.length > MAX_HASHES
              ? hashArr.slice(hashArr.length - MAX_HASHES)
              : hashArr;
          saveCaptureState({ ingestedHashes: trimmed });

          api.logger.info(
            `memory-mimir: capturing ${newCount} new messages (+${toSend.length - newCount} context)`,
          );

          client
            .ingestSession(
              cfg.userId,
              toSend.map(({ role, sender_name, content }) => ({
                role,
                sender_name,
                content,
              })),
              { groupId: cfg.groupId },
            )
            .then(() => {
              api.logger.info(
                `memory-mimir: captured ${toSend.length} messages`,
              );
            })
            .catch((err) => {
              api.logger.warn(`memory-mimir: capture failed: ${String(err)}`);
            });

          // Upload attachments from NEW messages only (skip already-processed ones).
          // We scan raw messages by index — only those after firstNewIdx in allParsed
          // could contain new attachments. Since messages and allParsed don't have 1:1
          // mapping, we use content-hash dedup: server deduplicates by content_hash,
          // but to avoid wasting bandwidth we also track locally.
          const newAttachments: ExtractedAttachment[] = [];
          // Only scan raw messages from the latter portion — approximate by skipping
          // the first firstNewIdx user/assistant messages.
          let rawSkip = firstNewIdx;
          for (const msg of messages) {
            if (!msg || typeof msg !== "object") continue;
            const role = (msg as Record<string, unknown>).role as string;
            if (role !== "user" && role !== "assistant") continue;
            if (rawSkip > 0) {
              rawSkip--;
              continue;
            }
            const extracted = extractAttachments(
              (msg as Record<string, unknown>).content,
            );
            newAttachments.push(...extracted);
          }

          if (newAttachments.length > 0) {
            api.logger.info(
              `memory-mimir: uploading ${newAttachments.length} attachments`,
            );
            Promise.allSettled(
              newAttachments.map((att) =>
                client.uploadFile(att.data, att.fileName, att.mimeType, {
                  groupId: cfg.groupId,
                  description: "Auto-captured from conversation",
                }),
              ),
            ).then((results) => {
              const succeeded = results.filter(
                (r) => r.status === "fulfilled",
              ).length;
              const failed = results.filter(
                (r) => r.status === "rejected",
              ).length;
              if (succeeded > 0) {
                api.logger.info(
                  `memory-mimir: uploaded ${succeeded}/${newAttachments.length} attachments`,
                );
              }
              if (failed > 0) {
                api.logger.warn(
                  `memory-mimir: ${failed}/${newAttachments.length} attachment uploads failed`,
                );
              }
            });
          }
        } catch (err) {
          api.logger.warn(`memory-mimir: capture setup failed: ${String(err)}`);
        }
      });
    }

    // ════════════════════════════════════════════════════════
    // Service
    // ════════════════════════════════════════════════════════

    api.registerService({
      id: "memory-mimir",
      start: () => {
        api.logger.info(
          `memory-mimir: started (user: ${cfg.userId}, server: ${cfg.mimirUrl})`,
        );
      },
      stop: () => {
        api.logger.info("memory-mimir: stopped");
      },
    });
  },
};

export default memoryMimirPlugin;
