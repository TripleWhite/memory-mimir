/**
 * Typed HTTP client for the Mimir unified memory REST API.
 * Pure fetch-based — no dependencies.
 */

// ─── Configuration ───────────────────────────────────────────

export interface MimirConfig {
  readonly url: string; // e.g. "http://localhost:8766"
  readonly apiKey?: string; // future auth
  readonly timeoutMs: number; // request timeout
}

export function defaultConfig(): MimirConfig {
  return {
    url: process.env.MIMIR_URL ?? "https://api.allinmimir.com",
    apiKey: process.env.MIMIR_API_KEY,
    timeoutMs: 30_000,
  };
}

// ─── API Response Envelope ───────────────────────────────────

export interface APIResponse<T = unknown> {
  readonly status: "ok" | "error";
  readonly message?: string;
  readonly result?: T;
  readonly error?: string;
}

// ─── Ingest Types ────────────────────────────────────────────

/** IngestResult — Go API returns PascalCase (no json tags on struct). */
export interface IngestResult {
  readonly EpisodeCount: number;
  readonly EntityCount: number;
  readonly RelationCount: number;
  readonly EventLogCount: number;
  readonly ForesightCount: number;
}

export interface SessionMessage {
  readonly role: "user" | "assistant";
  readonly sender_name: string;
  readonly content: string;
}

export interface IngestSessionRequest {
  readonly user_id: string;
  readonly group_id: string;
  readonly messages: readonly SessionMessage[];
  readonly timestamp?: string; // RFC3339
}

export interface IngestNoteRequest {
  readonly note_id?: string;
  readonly user_id: string;
  readonly group_id: string;
  readonly content: string;
  readonly timestamp?: string; // RFC3339
}

// ─── Search Types ────────────────────────────────────────────

export type RetrieveMethod =
  | "rrf"
  | "bm25"
  | "keyword"
  | "vector"
  | "agentic"
  | "full";

export interface SearchRequest {
  readonly query: string;
  readonly user_id: string;
  readonly group_id: string;
  readonly retrieve_method?: RetrieveMethod;
  readonly memory_types?: readonly string[];
  readonly top_k?: number;
  readonly start_time?: string;
  readonly end_time?: string;
}

export interface SearchResultItem {
  readonly id: string;
  readonly type: string; // "episode" | "entity" | "relation" | "event_log" | "foresight"
  readonly score: number;
  readonly sources: readonly string[];
  readonly data: Record<string, unknown>;
  readonly attachments?: readonly AttachmentItem[];
}

export interface AttachmentItem {
  readonly id: string;
  readonly file_name: string;
  readonly mime_type: string;
  readonly file_size: number;
  readonly signed_url: string;
  readonly description: string;
  readonly created_at: string;
}

export interface SearchResponse {
  readonly results: readonly SearchResultItem[];
  readonly foresight_context?: string;
}

// ─── Upload Types ───────────────────────────────────────────

export interface UploadFileResult {
  readonly id: string;
  readonly file_name: string;
  readonly mime_type: string;
  readonly file_size: number;
  readonly signed_url: string;
  readonly description: string;
  readonly created_at: string;
}

// ─── Graph Types ─────────────────────────────────────────────

export interface GraphTraverseRequest {
  readonly entity_names?: readonly string[];
  readonly entity_ids?: readonly string[];
  readonly group_id: string;
  readonly hops?: number;
  readonly max_results?: number;
}

export interface SeedEntityMatch {
  readonly input_name?: string;
  readonly entity_id: string;
  readonly match_type: "exact" | "fuzzy" | "id";
}

export interface Entity {
  readonly id: string;
  readonly name: string;
  readonly entity_type: string;
  readonly group_id: string;
  readonly summary: string;
  readonly aliases?: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Relation {
  readonly id: string;
  readonly source_entity_id: string;
  readonly target_entity_id: string;
  readonly relation_type: string;
  readonly fact: string;
  readonly valid_at?: string;
  readonly invalid_at?: string;
}

export interface GraphTraverseResult {
  readonly seed_entities: readonly SeedEntityMatch[];
  readonly entities: readonly Entity[];
  readonly relations: readonly Relation[];
  readonly total_entities: number;
  readonly total_relations: number;
}

// ─── Batch Notes Types ──────────────────────────────────────

export interface BatchNoteItemResult {
  readonly note_id: string;
  readonly status: "ok" | "error";
  readonly error?: string;
  readonly result?: IngestResult;
}

export interface BatchNotesResponse {
  readonly total: number;
  readonly success: number;
  readonly failed: number;
  readonly items: readonly BatchNoteItemResult[];
  readonly combined: IngestResult;
}

// ─── Consolidation ───────────────────────────────────────────

export interface ConsolidateRequest {
  readonly user_id: string;
}

// ─── Client ──────────────────────────────────────────────────

export class MimirClient {
  private readonly config: MimirConfig;

  constructor(config?: Partial<MimirConfig>) {
    const merged = { ...defaultConfig(), ...config };
    this.config = { ...merged, url: validateUrl(merged.url) };
  }

  /**
   * Register an anonymous device. No auth required.
   * POST /api/v1/device/init
   */
  async deviceInit(options?: { inviteCode?: string }): Promise<{
    device_key: string;
    pairing_code?: string;
    memory_user_id?: string;
    is_recovery?: boolean;
  }> {
    const url = `${this.config.url}/api/v1/device/init`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          options?.inviteCode ? { invite_code: options.inviteCode } : {},
        ),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new MimirError(
          `POST /api/v1/device/init failed: ${resp.status} ${body}`,
          resp.status,
        );
      }
      return (await resp.json()) as {
        device_key: string;
        pairing_code?: string;
        memory_user_id?: string;
        is_recovery?: boolean;
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Validate API key and fetch user identity from /api/v1/me. */
  async me(): Promise<{
    user_id: string;
    group_id: string;
    display_name: string;
  }> {
    const url = `${this.config.url}/api/v1/me`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new MimirError(
          `GET /api/v1/me failed: ${resp.status} ${body}`,
          resp.status,
        );
      }
      return (await resp.json()) as {
        user_id: string;
        group_id: string;
        display_name: string;
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Health check — returns true if Mimir is reachable. */
  async health(): Promise<boolean> {
    try {
      const resp = await this.get<{ status: string }>("/health");
      return resp.status === "ok";
    } catch {
      return false;
    }
  }

  /** Search memory. Default retrieve_method: "full" (RRF + graph traverse). */
  async search(
    userId: string,
    query: string,
    options?: {
      readonly groupId?: string;
      readonly retrieveMethod?: RetrieveMethod;
      readonly memoryTypes?: readonly string[];
      readonly topK?: number;
      readonly startTime?: string;
      readonly endTime?: string;
    },
  ): Promise<SearchResponse> {
    const body: SearchRequest = {
      query,
      user_id: userId,
      group_id: options?.groupId ?? userId,
      retrieve_method: options?.retrieveMethod ?? "full",
      memory_types: options?.memoryTypes,
      top_k: options?.topK ?? 10,
      start_time: options?.startTime,
      end_time: options?.endTime,
    };

    const resp = await this.post<SearchResponse>("/api/v1/search", body);
    return resp.result ?? { results: [] };
  }

  /** Ingest a conversation session (batch of messages). */
  async ingestSession(
    userId: string,
    messages: readonly SessionMessage[],
    options?: { readonly groupId?: string; readonly timestamp?: string },
  ): Promise<IngestResult> {
    const body: IngestSessionRequest = {
      user_id: userId,
      group_id: options?.groupId ?? userId,
      messages,
      timestamp: options?.timestamp,
    };

    const resp = await this.post<IngestResult>("/api/v1/ingest/session", body);
    return resp.result ?? emptyIngestResult();
  }

  /** Ingest a single note/fact. */
  async ingestNote(
    userId: string,
    content: string,
    options?: {
      readonly groupId?: string;
      readonly noteId?: string;
      readonly timestamp?: string;
    },
  ): Promise<IngestResult> {
    const body: IngestNoteRequest = {
      user_id: userId,
      group_id: options?.groupId ?? userId,
      note_id: options?.noteId,
      content,
      timestamp: options?.timestamp,
    };

    const resp = await this.post<IngestResult>("/api/v1/ingest/note", body);
    return resp.result ?? emptyIngestResult();
  }

  /** Batch ingest multiple notes concurrently (server-side parallelism). */
  async ingestBatchNotes(
    notes: readonly {
      readonly userId: string;
      readonly groupId?: string;
      readonly noteId?: string;
      readonly content: string;
      readonly timestamp?: string;
    }[],
    options?: { readonly concurrency?: number },
  ): Promise<BatchNotesResponse> {
    const body = {
      notes: notes.map((n) => ({
        note_id: n.noteId,
        user_id: n.userId,
        group_id: n.groupId ?? n.userId,
        content: n.content,
        timestamp: n.timestamp,
      })),
      concurrency: options?.concurrency ?? 3,
    };

    const resp = await this.post<BatchNotesResponse>(
      "/api/v1/ingest/batch-notes",
      body,
    );
    return (
      resp.result ?? {
        total: 0,
        success: 0,
        failed: 0,
        items: [],
        combined: emptyIngestResult(),
      }
    );
  }

  /** Trigger profile consolidation. */
  async consolidate(userId: string): Promise<void> {
    const body: ConsolidateRequest = { user_id: userId };
    await this.post("/api/v1/consolidate", body);
  }

  /** Traverse knowledge graph from entity names. */
  async graphTraverse(
    entityNames: readonly string[],
    groupId: string,
    options?: { readonly hops?: number; readonly maxResults?: number },
  ): Promise<GraphTraverseResult> {
    const body: GraphTraverseRequest = {
      entity_names: entityNames,
      group_id: groupId,
      hops: options?.hops ?? 2,
      max_results: options?.maxResults ?? 50,
    };

    const resp = await this.post<GraphTraverseResult>(
      "/api/v1/graph/traverse",
      body,
    );
    return (
      resp.result ?? {
        seed_entities: [],
        entities: [],
        relations: [],
        total_entities: 0,
        total_relations: 0,
      }
    );
  }

  /** Upload a file to Mimir storage. Returns attachment metadata with signed URL. */
  async uploadFile(
    fileData: Uint8Array,
    fileName: string,
    mimeType: string,
    options?: {
      readonly groupId?: string;
      readonly description?: string;
      readonly episodeId?: string;
    },
  ): Promise<UploadFileResult> {
    const url = `${this.config.url}/api/v1/files/upload`;
    const controller = new AbortController();
    const uploadTimeoutMs = Math.max(this.config.timeoutMs, 120_000); // min 2 min for large files
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);

    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([fileData as BlobPart], { type: mimeType }),
        fileName,
      );
      if (options?.groupId) form.append("group_id", options.groupId);
      if (options?.description) form.append("description", options.description);
      if (options?.episodeId) form.append("episode_id", options.episodeId);

      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      // Do NOT set Content-Type — let fetch set multipart boundary automatically

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new MimirError(
          `POST /api/v1/files/upload failed: ${resp.status} ${body}`,
          resp.status,
        );
      }

      const json = (await resp.json()) as APIResponse<UploadFileResult>;
      if (json.status === "error") {
        throw new MimirError(`POST /api/v1/files/upload: ${json.error}`, 500);
      }

      return (
        json.result ?? {
          id: "",
          file_name: "",
          mime_type: "",
          file_size: 0,
          signed_url: "",
          description: "",
          created_at: "",
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── HTTP Helpers ────────────────────────────────────────

  private async get<T>(path: string): Promise<APIResponse<T>> {
    return this.withRetry(() => this.doGet<T>(path));
  }

  private async doGet<T>(path: string): Promise<APIResponse<T>> {
    const url = `${this.config.url}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new MimirError(
          `GET ${path} failed: ${resp.status} ${body}`,
          resp.status,
        );
      }

      const json = (await resp.json()) as APIResponse<T>;
      if (json.status === "error") {
        throw new MimirError(`GET ${path}: ${json.error}`, 500);
      }
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<APIResponse<T>> {
    const isIngest = path.includes("/ingest") || path.includes("/consolidate");
    // No retry for long-running ingest/consolidate
    if (isIngest) return this.doPost<T>(path, body);
    return this.withRetry(() => this.doPost<T>(path, body));
  }

  private async doPost<T>(
    path: string,
    body: unknown,
  ): Promise<APIResponse<T>> {
    const url = `${this.config.url}${path}`;
    const controller = new AbortController();
    const isIngest = path.includes("/ingest") || path.includes("/consolidate");
    const timeoutMs = isIngest
      ? Math.max(this.config.timeoutMs, 900_000)
      : this.config.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new MimirError(
          `POST ${path} failed: ${resp.status} ${text}`,
          resp.status,
        );
      }

      const json = (await resp.json()) as APIResponse<T>;
      if (json.status === "error") {
        throw new MimirError(`POST ${path}: ${json.error}`, 500);
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Retry on transient network errors (timeout, connection reset). */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 1): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        // Only retry on network/timeout errors, not on 4xx/5xx
        if (err instanceof MimirError) throw err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      h["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }
}

// ─── Error ───────────────────────────────────────────────────

export class MimirError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "MimirError";
    this.statusCode = statusCode;
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function emptyIngestResult(): IngestResult {
  return {
    EpisodeCount: 0,
    EntityCount: 0,
    RelationCount: 0,
    EventLogCount: 0,
    ForesightCount: 0,
  };
}

/** Validate and normalize the Mimir server URL. */
function validateUrl(raw: string): string {
  const parsed = new URL(raw); // throws on malformed URL
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `MIMIR_URL must use http or https, got: ${parsed.protocol}`,
    );
  }
  return raw.replace(/\/$/, ""); // strip trailing slash
}
