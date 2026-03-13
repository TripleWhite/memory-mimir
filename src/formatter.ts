/**
 * Format Mimir search results into compact, agent-friendly text.
 * Items are rendered in server-computed score order (no grouping by type).
 * Token budget: ~500 tokens max for auto-recall context.
 */

import type {
  SearchResponse,
  SearchResultItem,
  GraphTraverseResult,
  Entity,
} from "./mimir-client.js";

// ─── Configuration ───────────────────────────────────────────

export interface FormatterOptions {
  /** Max characters for the entire formatted block. ~500 tokens ≈ 2000 chars. */
  readonly maxChars: number;
  /** Max individual memory items to show. */
  readonly maxItems: number;
}

const DEFAULT_OPTIONS: FormatterOptions = {
  maxChars: 3000,
  maxItems: 12,
};

// ─── Main Formatter ──────────────────────────────────────────

/** Format search results as a compact memory context block.
 *  Items are rendered in score order (as returned by server), not grouped by type.
 */
export function formatSearchResults(
  response: SearchResponse,
  options?: Partial<FormatterOptions>,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { results } = response;

  if (results.length === 0) {
    return "";
  }

  const lines: string[] = [];
  let charCount = 0;
  let itemCount = 0;

  for (const item of results) {
    if (itemCount >= opts.maxItems) break;

    const line = formatItem(item);
    if (!line) continue;

    // Check char budget before adding (account for newline)
    if (charCount + line.length + 1 > opts.maxChars) break;

    lines.push(line);
    charCount += line.length + 1;
    itemCount++;
  }

  // Append foresight_context if present
  if (response.foresight_context) {
    const fLine = `> ${response.foresight_context}`;
    if (charCount + fLine.length + 1 <= opts.maxChars) {
      lines.push(fLine);
    }
  }

  return lines.join("\n");
}

/** Format graph traverse results as a relationship summary. */
export function formatGraphResults(result: GraphTraverseResult): string {
  if (result.entities.length === 0) {
    return "";
  }

  const lines: string[] = ["## Entity Relationships"];

  // Format entities with their summaries
  for (const entity of result.entities.slice(0, 5)) {
    const aliases = entity.aliases?.length
      ? ` (aka ${entity.aliases.join(", ")})`
      : "";
    lines.push(
      `- **${entity.name}**${aliases}: ${entity.summary || entity.entity_type}`,
    );
  }

  // Format relations as "A → relation → B"
  if (result.relations.length > 0) {
    lines.push("");
    const entityById = new Map<string, Entity>();
    for (const e of result.entities) {
      entityById.set(e.id, e);
    }

    for (const rel of result.relations.slice(0, 5)) {
      const source = entityById.get(rel.source_entity_id)?.name ?? "?";
      const target = entityById.get(rel.target_entity_id)?.name ?? "?";
      lines.push(`- ${source} → ${rel.relation_type} → ${target}: ${rel.fact}`);
    }
  }

  return lines.join("\n");
}

// ─── Item Dispatcher ─────────────────────────────────────────

/** Format a single result item with a type-specific prefix. */
function formatItem(item: SearchResultItem): string {
  const data = item.data;
  let line: string;

  switch (item.type) {
    case "episode":
    case "raw_doc": {
      const date = formatDate(data.occurred_at as string | undefined);
      const title = (data.title as string) || "";
      const content = (data.content as string) || "";
      const summary = title || firstLine(content);
      line = `- [${date}] ${truncate(summary, 200)}`;
      break;
    }

    case "event_log": {
      const date = formatDate(data.timestamp as string | undefined);
      const fact = (data.fact as string) || "";
      line = `- [${date}] ${truncate(fact, 200)}`;
      break;
    }

    case "entity": {
      const name = (data.name as string) || "";
      const entityType = (data.entity_type as string) || "";
      const summary = (data.summary as string) || "";
      line = `- [entity] ${name} (${entityType}): ${truncate(summary, 200)}`;
      break;
    }

    case "relation": {
      const fact = (data.fact as string) || "";
      const relType = (data.relation_type as string) || "";
      const sourceName = (data.source_entity_name as string) || "";
      const targetName = (data.target_entity_name as string) || "";
      const label =
        sourceName && targetName ? `${sourceName} → ${targetName}` : relType;
      line = `- [relation] ${label}: ${truncate(fact, 200)}`;
      break;
    }

    case "foresight": {
      const content = (data.content as string) || "";
      line = `- [upcoming] ${truncate(content, 150)}`;
      break;
    }

    default:
      return "";
  }

  // Append attachment indicators if present
  if (item.attachments && item.attachments.length > 0) {
    const attParts = item.attachments.map((att) => att.file_name);
    const suffix = ` [files: ${attParts.join(", ")}]`;
    line += truncate(suffix, 80);
  }

  return line;
}

// ─── Helpers ─────────────────────────────────────────────────

function formatDate(isoDate: string | undefined): string {
  if (!isoDate) return "unknown";
  try {
    const d = new Date(isoDate);
    return d.toISOString().slice(0, 10); // "2023-07-15"
  } catch {
    return "unknown";
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx >= 0 ? s.slice(0, idx) : s;
}
