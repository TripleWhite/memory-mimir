/**
 * memory-mimir: OpenClaw plugin entry point.
 *
 * Replaces OpenClaw's built-in file-backed memory with Mimir
 * as a full long-term memory backend (graph + vector + BM25).
 */

import { Type } from "@sinclair/typebox";
import { MimirClient, MimirError } from "./mimir-client.js";
import { formatSearchResults } from "./formatter.js";
import { migrate, hasExistingData, hasLocalMemories } from "./migration.js";

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
  readonly userId: string;
  readonly groupId: string;
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
      "http://localhost:8766",
    userId:
      (pluginConfig.userId as string) ??
      process.env.MIMIR_USER_ID ??
      process.env.USER ??
      "default",
    groupId:
      (pluginConfig.groupId as string) ??
      process.env.MIMIR_GROUP_ID ??
      process.env.MIMIR_USER_ID ??
      process.env.USER ??
      "default",
    autoRecall:
      (pluginConfig.autoRecall as boolean) ??
      process.env.MIMIR_AUTO_RECALL !== "false",
    autoCapture:
      (pluginConfig.autoCapture as boolean) ??
      process.env.MIMIR_AUTO_CAPTURE !== "false",
    maxRecallTokens: parsePositiveInt(
      pluginConfig.maxRecallTokens as number | undefined,
      500,
    ),
    maxRecallItems: parsePositiveInt(
      pluginConfig.maxRecallItems as number | undefined,
      8,
    ),
  };
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

// ─── Keyword Extraction (no LLM) ───────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "must",
  "need",
  "dare",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "about",
  "also",
  "back",
  "even",
  "still",
  "then",
  "there",
  "here",
  "when",
  "where",
  "why",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "him",
  "her",
  "they",
  "them",
  "their",
  "if",
  "up",
  "out",
  "please",
  "tell",
  "know",
  "think",
  "want",
  "like",
  "get",
  "make",
  "go",
  "come",
  "take",
  "see",
  "look",
  "find",
  "give",
  "use",
  "say",
  "said",
  "help",
  "try",
  "let",
  "put",
  "keep",
  "start",
  "remember",
  "recall",
  "mentioned",
  "talked",
  "discussed",
]);

/** Detect CJK characters in text. */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(
    text,
  );
}

/** Extract searchable topics from user message — pure heuristic, no LLM.
 *  For CJK text: pass first 200 chars directly (server has LLMTranslator + RuleAnalyzer).
 *  For English: extract up to 8 non-stop-word tokens.
 */
export function extractKeywords(message: string): string {
  // CJK: pass raw text to server — it handles segmentation and translation
  if (hasCJK(message)) {
    return message.slice(0, 200).trim();
  }

  const words = message
    .toLowerCase()
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const unique = [...new Set(words)].slice(0, 8);
  return unique.join(" ");
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
    const cfg = resolveConfig(api.pluginConfig ?? {});
    const client = new MimirClient({ url: cfg.mimirUrl });

    api.logger.info(
      `memory-mimir: registered (user: ${cfg.userId}, server: ${cfg.mimirUrl})`,
    );

    // ════════════════════════════════════════════════════════
    // Tools
    // ════════════════════════════════════════════════════════

    api.registerTool(
      {
        name: "mimir_search",
        label: "Mimir Search",
        description:
          "Search long-term memory for past conversations, facts, entities, and relationships. " +
          "Use when the user asks about past events, people, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "The search query" }),
          types: Type.Optional(
            Type.String({
              description:
                "Comma-separated memory types: episode,entity,relation,event_log,foresight. Default: all.",
            }),
          ),
          startTime: Type.Optional(
            Type.String({
              description:
                "Filter results after this time (ISO 8601, e.g. 2026-02-25T00:00:00Z).",
            }),
          ),
          endTime: Type.Optional(
            Type.String({
              description:
                "Filter results before this time (ISO 8601, e.g. 2026-03-04T00:00:00Z).",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const query = params.query as string;
          const typesStr = params.types as string | undefined;
          const memoryTypes =
            typesStr?.split(",").map((t) => t.trim()) ?? undefined;
          const startTime = params.startTime as string | undefined;
          const endTime = params.endTime as string | undefined;

          try {
            const results = await client.search(cfg.userId, query, {
              groupId: cfg.groupId,
              memoryTypes,
              topK: 10,
              retrieveMethod: "agentic",
              startTime,
              endTime,
            });

            if (results.results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No memories found matching your query.",
                  },
                ],
                details: { count: 0 },
              };
            }

            const formatted = formatSearchResults(results, {
              maxItems: 10,
              maxChars: 4000,
            });
            return {
              content: [{ type: "text", text: formatted }],
              details: { count: results.results.length },
            };
          } catch (err) {
            const msg = err instanceof MimirError ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Memory search failed: ${msg}` }],
              details: { error: msg },
            };
          }
        },
      },
      { name: "mimir_search" },
    );

    api.registerTool(
      {
        name: "mimir_store",
        label: "Mimir Store",
        description:
          "Store an important fact, preference, or note in long-term memory. " +
          'Use when the user says "remember this" or shares important information.',
        parameters: Type.Object({
          content: Type.String({
            description: "The fact, preference, or note to remember",
          }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const content = params.content as string;

          try {
            const result = await client.ingestNote(cfg.userId, content, {
              groupId: cfg.groupId,
            });

            const text =
              `Stored in memory. Extracted ${result.EpisodeCount} episode(s), ` +
              `${result.EntityCount} entity(ies), ${result.RelationCount} relation(s).`;
            return {
              content: [{ type: "text", text }],
              details: {
                episodes: result.EpisodeCount,
                entities: result.EntityCount,
              },
            };
          } catch (err) {
            const msg = err instanceof MimirError ? err.message : String(err);
            return {
              content: [
                { type: "text", text: `Failed to store memory: ${msg}` },
              ],
              details: { error: msg },
            };
          }
        },
      },
      { name: "mimir_store" },
    );

    api.registerTool(
      {
        name: "mimir_forget",
        label: "Mimir Forget",
        description:
          "Look up information in memory the user wants to forget. " +
          "NOTE: Deletion is not yet implemented — this shows what would be affected.",
        parameters: Type.Object({
          query: Type.String({ description: "Description of what to forget" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const query = (params.query as string)?.trim();
          if (!query || query.length > 1000) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: query must be 1-1000 characters.",
                },
              ],
              details: { error: "invalid_query" },
            };
          }

          try {
            const results = await client.search(cfg.userId, query, {
              groupId: cfg.groupId,
              topK: 5,
            });

            if (results.results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No matching memories found." },
                ],
                details: { count: 0 },
              };
            }

            const preview = formatSearchResults(results, {
              maxItems: 5,
              maxChars: 2000,
            });
            const text =
              `Found ${results.results.length} matching item(s). ` +
              `Deletion is not yet supported.\n\n${preview}`;
            return {
              content: [{ type: "text", text }],
              details: { count: results.results.length },
            };
          } catch (err) {
            const msg = err instanceof MimirError ? err.message : String(err);
            return {
              content: [{ type: "text", text: `Forget lookup failed: ${msg}` }],
              details: { error: msg },
            };
          }
        },
      },
      { name: "mimir_forget" },
    );

    // ════════════════════════════════════════════════════════
    // CLI Commands
    // ════════════════════════════════════════════════════════

    api.registerCli(
      ({ program }) => {
        const mimir = program
          .command("mimir")
          .description("Mimir memory plugin commands");

        mimir
          .command("setup")
          .description("Show Mimir configuration and test connectivity")
          .action(async () => {
            console.log(`Mimir Memory Plugin v0.1.0`);
            console.log(`──────────────────────────`);
            console.log(`Server URL:   ${cfg.mimirUrl}`);
            console.log(`User ID:      ${cfg.userId}`);
            console.log(`Group ID:     ${cfg.groupId}`);
            console.log(
              `Auto-recall:  ${cfg.autoRecall ? "enabled" : "disabled"}`,
            );
            console.log(
              `Auto-capture: ${cfg.autoCapture ? "enabled" : "disabled"}`,
            );
            console.log();

            const healthy = await client.health();
            if (healthy) {
              console.log(`Connection:   OK`);
            } else {
              console.log(
                `Connection:   FAILED — cannot reach ${cfg.mimirUrl}`,
              );
              console.log(
                `  Set MIMIR_URL or plugins.entries.memory-mimir.mimirUrl`,
              );
            }
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

          const timeRange = extractTimeRange(prompt);
          const results = await client.search(cfg.userId, query, {
            groupId: cfg.groupId,
            topK: cfg.maxRecallItems,
            retrieveMethod: "agentic",
            startTime: timeRange?.start,
            endTime: timeRange?.end,
          });

          if (results.results.length === 0) return;

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
    // Uses incremental tracking to avoid re-ingesting messages that
    // were already captured in a previous agent_end for the same session.
    if (cfg.autoCapture) {
      // Incremental capture state (in-memory, resets on process restart).
      // We track by the content hash of the first message to detect session resets.
      const CONTEXT_WINDOW = 4; // preceding messages included for LLM context
      let capturedCount = 0;
      let sessionFingerprint = "";

      api.on("agent_end", async (event) => {
        const success = event.success as boolean | undefined;
        const messages = event.messages as
          | Array<Record<string, unknown>>
          | undefined;

        if (!success || !messages || messages.length === 0) return;

        try {
          // Parse all valid messages first.
          const allParsed: Array<{
            role: "user" | "assistant";
            sender_name: string;
            content: string;
          }> = [];

          for (const msg of messages) {
            if (!msg || typeof msg !== "object") continue;
            const role = msg.role as string;
            if (role !== "user" && role !== "assistant") continue;

            let content = "";
            if (typeof msg.content === "string") {
              content = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textBlocks = (msg.content as Array<Record<string, unknown>>)
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text as string);
              content = textBlocks.join("\n");
            }

            if (!content || content.includes("<memories>")) continue;

            allParsed.push({
              role: role as "user" | "assistant",
              sender_name: role === "user" ? cfg.userId : "assistant",
              content,
            });
          }

          if (allParsed.length === 0) return;

          // Detect session reset (/new, /reset) by checking first message.
          const fingerprint = allParsed[0].content.slice(0, 200);
          if (fingerprint !== sessionFingerprint) {
            capturedCount = 0;
            sessionFingerprint = fingerprint;
          }

          // Nothing new since last capture.
          if (allParsed.length <= capturedCount) return;

          // Slice: context window (already captured, for LLM context) + new messages.
          const contextStart = Math.max(0, capturedCount - CONTEXT_WINDOW);
          const sessionMessages = allParsed.slice(contextStart);
          const newCount = allParsed.length - capturedCount;

          capturedCount = allParsed.length;

          api.logger.info(
            `memory-mimir: capturing ${newCount} new messages (+${sessionMessages.length - newCount} context) (fire-and-forget)`,
          );

          // Fire-and-forget: don't await because agent process may shut down
          // before Mimir finishes processing. The server-side ingestContext()
          // already detaches from client context, so it will complete even if
          // we disconnect.
          client
            .ingestSession(cfg.userId, sessionMessages, {
              groupId: cfg.groupId,
            })
            .then(() => {
              api.logger.info(
                `memory-mimir: captured ${sessionMessages.length} messages`,
              );
            })
            .catch((err) => {
              api.logger.warn(`memory-mimir: capture failed: ${String(err)}`);
            });
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
