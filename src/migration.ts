/**
 * Migration: Import existing OpenClaw/Claude Code memories into Mimir.
 *
 * Scans MEMORY.md and daily memory files, ingests each as a note,
 * then triggers consolidation.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import type {
  MimirClient,
  IngestResult,
  BatchNotesResponse,
} from "./mimir-client.js";
import { extractDateFromFilename } from "./migration-helpers.js";

// ─── Types ───────────────────────────────────────────────────

export interface MigrationResult {
  readonly filesFound: number;
  readonly filesIngested: number;
  readonly filesFailed: number;
  readonly totalEpisodes: number;
  readonly totalEntities: number;
  readonly totalRelations: number;
  readonly errors: readonly string[];
}

export interface MigrationOptions {
  /** Override the memory directory path. */
  readonly memoryDir?: string;
  /** User ID for Mimir ingestion. */
  readonly userId: string;
  /** Group ID (defaults to userId). */
  readonly groupId?: string;
  /** Progress callback: (current, total, filename) => void. */
  readonly onProgress?: (
    current: number,
    total: number,
    filename: string,
  ) => void;
  /** If true, skip user confirmation. */
  readonly autoMigrate?: boolean;
}

// ─── Default Paths ───────────────────────────────────────────

/** Find OpenClaw/Claude Code memory directories. */
export function findMemoryPaths(): string[] {
  const home = homedir();
  const candidates = [
    // Claude Code auto-memory
    join(home, ".claude", "memory"),
    // Claude Code project-specific memory
    join(home, ".claude", "projects"),
    // OpenClaw workspace memory
    join(home, ".openclaw", "workspace", "memory"),
    // OpenClaw memory
    join(home, ".openclaw", "memory"),
  ];
  return candidates;
}

// ─── Core Migration ──────────────────────────────────────────

/** Discover all markdown memory files in a directory tree. */
export async function discoverMemoryFiles(baseDir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(baseDir, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subFiles = await discoverMemoryFiles(fullPath);
        files.push(...subFiles);
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === ".md"
      ) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or not readable — skip
  }

  return files.sort();
}

/** Parse a memory file into content suitable for Mimir ingestion. */
async function parseMemoryFile(filePath: string): Promise<{
  readonly content: string;
  readonly timestamp?: string;
  readonly noteId: string;
}> {
  const raw = await readFile(filePath, "utf-8");
  const content = raw.trim();
  const timestamp = extractDateFromFilename(filePath);
  const noteId = `migration-${basename(filePath, extname(filePath))}`;

  return { content, timestamp, noteId };
}

/** Run the full migration: discover files → batch ingest → consolidate. */
export async function migrate(
  client: MimirClient,
  options: MigrationOptions,
): Promise<MigrationResult> {
  const memoryDir = options.memoryDir ?? findMemoryPaths()[0];
  const groupId = options.groupId ?? options.userId;

  // 1. Discover files
  const files = await discoverMemoryFiles(memoryDir);

  if (files.length === 0) {
    return {
      filesFound: 0,
      filesIngested: 0,
      filesFailed: 0,
      totalEpisodes: 0,
      totalEntities: 0,
      totalRelations: 0,
      errors: [`No .md files found in ${memoryDir}`],
    };
  }

  // 2. Parse all files
  const parsedNotes: Array<{
    readonly filename: string;
    readonly content: string;
    readonly timestamp?: string;
    readonly noteId: string;
  }> = [];

  for (const filePath of files) {
    const { content, timestamp, noteId } = await parseMemoryFile(filePath);
    if (!content) continue;
    parsedNotes.push({
      filename: basename(filePath),
      content,
      timestamp,
      noteId,
    });
  }

  if (parsedNotes.length === 0) {
    return {
      filesFound: files.length,
      filesIngested: 0,
      filesFailed: 0,
      totalEpisodes: 0,
      totalEntities: 0,
      totalRelations: 0,
      errors: ["All files were empty"],
    };
  }

  options.onProgress?.(0, parsedNotes.length, "starting batch ingestion...");

  // 3. Try batch endpoint first (server-side parallelism)
  const errors: string[] = [];
  let filesIngested = 0;
  let filesFailed = 0;
  let totalEpisodes = 0;
  let totalEntities = 0;
  let totalRelations = 0;

  try {
    const batchResp = await client.ingestBatchNotes(
      parsedNotes.map((n) => ({
        userId: options.userId,
        groupId,
        noteId: n.noteId,
        content: n.content,
        timestamp: n.timestamp,
      })),
      { concurrency: 3 },
    );

    // Report per-item results
    for (let i = 0; i < batchResp.items.length; i++) {
      const item = batchResp.items[i];
      const filename = parsedNotes[i]?.filename ?? `note-${i}`;
      options.onProgress?.(i + 1, parsedNotes.length, filename);

      if (item.status === "ok") {
        filesIngested++;
      } else {
        filesFailed++;
        errors.push(`${filename}: ${item.error ?? "unknown error"}`);
      }
    }

    totalEpisodes = batchResp.combined.EpisodeCount;
    totalEntities = batchResp.combined.EntityCount;
    totalRelations = batchResp.combined.RelationCount;
  } catch {
    // Batch endpoint not available — fall back to sequential
    for (let i = 0; i < parsedNotes.length; i++) {
      const note = parsedNotes[i];
      options.onProgress?.(i + 1, parsedNotes.length, note.filename);

      try {
        const result: IngestResult = await client.ingestNote(
          options.userId,
          note.content,
          { groupId, noteId: note.noteId, timestamp: note.timestamp },
        );

        filesIngested++;
        totalEpisodes += result.EpisodeCount;
        totalEntities += result.EntityCount;
        totalRelations += result.RelationCount;
      } catch (err) {
        filesFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${note.filename}: ${msg}`);
      }
    }
  }

  // 4. Trigger consolidation after migration
  try {
    await client.consolidate(options.userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Consolidation failed: ${msg}`);
  }

  return {
    filesFound: files.length,
    filesIngested,
    filesFailed,
    totalEpisodes,
    totalEntities,
    totalRelations,
    errors,
  };
}

/** Check if a user has existing Mimir data. */
export async function hasExistingData(
  client: MimirClient,
  userId: string,
): Promise<boolean> {
  try {
    const resp = await client.search(userId, "memory", { topK: 1 });
    return resp.results.length > 0;
  } catch {
    return false;
  }
}

/** Check if local memory files exist. */
export async function hasLocalMemories(): Promise<boolean> {
  for (const dir of findMemoryPaths()) {
    const files = await discoverMemoryFiles(dir);
    if (files.length > 0) return true;
  }
  return false;
}
