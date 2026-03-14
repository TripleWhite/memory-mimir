/**
 * Unit tests for memory-mimir plugin.
 * Run with: npx tsx src/test.ts
 */

import * as fs from "node:fs";
import { formatSearchResults, formatGraphResults } from "./formatter.js";
import { extractAttachments, extractKeywords } from "./index.js";
import { extractDateFromFilename } from "./migration-helpers.js";
import type { SearchResponse, GraphTraverseResult } from "./mimir-client.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── Formatter Tests ─────────────────────────────────────────

console.log("\n=== Formatter Tests ===\n");

// Test: empty results
{
  const response: SearchResponse = { results: [] };
  const result = formatSearchResults(response);
  assertEqual(result, "", "empty results → empty string");
}

// Test: episode formatting
{
  const response: SearchResponse = {
    results: [
      {
        id: "ep-1",
        type: "episode",
        score: 0.9,
        sources: ["bm25", "vector"],
        data: {
          title: "Calvin prefers dark roast coffee",
          content:
            "Calvin mentioned he likes dark roast coffee from Blue Bottle",
          occurred_at: "2023-07-15T10:30:00Z",
        },
      },
    ],
  };
  const result = formatSearchResults(response);
  assert(result.includes("[2023-07-15]"), "has date");
  assert(result.includes("dark roast coffee"), "has content");
}

// Test: multiple types
{
  const response: SearchResponse = {
    results: [
      {
        id: "ep-1",
        type: "episode",
        score: 0.9,
        sources: ["bm25"],
        data: {
          title: "Meeting about Q4",
          occurred_at: "2023-08-01T00:00:00Z",
        },
      },
      {
        id: "ent-1",
        type: "entity",
        score: 0.8,
        sources: ["vector"],
        data: {
          name: "Sarah",
          entity_type: "person",
          summary: "Project manager at Google",
        },
      },
      {
        id: "rel-1",
        type: "relation",
        score: 0.7,
        sources: ["graph"],
        data: {
          relation_type: "married_to",
          fact: "Calvin is married to Sarah",
        },
      },
    ],
  };
  const result = formatSearchResults(response);
  assert(result.includes("[entity] Sarah"), "has entity with prefix");
  assert(result.includes("[relation] married_to"), "has relation with prefix");
}

// Test: foresight context
{
  const response: SearchResponse = {
    results: [
      {
        id: "ep-1",
        type: "episode",
        score: 0.9,
        sources: ["bm25"],
        data: { title: "Test", occurred_at: "2023-01-01T00:00:00Z" },
      },
    ],
    foresight_context: "User has a trip to Japan planned for October",
  };
  const result = formatSearchResults(response);
  assert(result.includes("trip to Japan"), "has foresight context");
}

// Test: truncation
{
  const longContent = "A".repeat(1000);
  const response: SearchResponse = {
    results: [
      {
        id: "ep-1",
        type: "episode",
        score: 0.9,
        sources: ["bm25"],
        data: { title: longContent, occurred_at: "2023-01-01T00:00:00Z" },
      },
    ],
  };
  const result = formatSearchResults(response, { maxChars: 200, maxItems: 8 });
  assert(result.length <= 200, `truncated to maxChars (got ${result.length})`);
}

// Test: graph results formatting
{
  const graphResult: GraphTraverseResult = {
    seed_entities: [
      { input_name: "Calvin", entity_id: "e1", match_type: "exact" },
    ],
    entities: [
      {
        id: "e1",
        name: "Calvin",
        entity_type: "person",
        group_id: "g1",
        summary: "Software engineer",
        created_at: "2023-01-01",
        updated_at: "2023-07-01",
      },
      {
        id: "e2",
        name: "Sarah",
        entity_type: "person",
        group_id: "g1",
        summary: "Product manager at Google",
        created_at: "2023-01-01",
        updated_at: "2023-07-01",
      },
    ],
    relations: [
      {
        id: "r1",
        source_entity_id: "e1",
        target_entity_id: "e2",
        relation_type: "married_to",
        fact: "Calvin is married to Sarah",
      },
    ],
    total_entities: 2,
    total_relations: 1,
  };
  const result = formatGraphResults(graphResult);
  assert(result.includes("## Entity Relationships"), "has graph header");
  assert(result.includes("**Calvin**"), "has source entity");
  assert(result.includes("Calvin is married to Sarah"), "has relation fact");
}

// ─── Date Extraction Tests ───────────────────────────────────

console.log("\n=== Date Extraction Tests ===\n");

{
  assertEqual(
    extractDateFromFilename("2025-03-01.md"),
    "2025-03-01T00:00:00Z",
    "ISO date filename",
  );
  assertEqual(
    extractDateFromFilename("memory-2025-03-01.md"),
    "2025-03-01T00:00:00Z",
    "prefixed ISO date filename",
  );
  assertEqual(
    extractDateFromFilename("20250301.md"),
    "2025-03-01T00:00:00Z",
    "compact date filename",
  );
  assertEqual(
    extractDateFromFilename("MEMORY.md"),
    undefined,
    "no date in filename",
  );
  assertEqual(
    extractDateFromFilename("random-notes.md"),
    undefined,
    "no date in arbitrary filename",
  );
}

// ─── extractKeywords Tests ───────────────────────────────────

console.log("\n=== extractKeywords Tests ===\n");

{
  // Preserves original case for entity matching
  const result1 = extractKeywords(
    "Do you remember what Calvin said about coffee?",
  );
  assert(result1.includes("Calvin"), "preserves 'Calvin' casing");
  assert(result1.includes("coffee"), "keeps 'coffee'");

  // CJK: truncates at 1000 chars
  const cjk = "你好".repeat(600);
  const cjkResult = extractKeywords(cjk);
  assertEqual(cjkResult.length, 1000, "CJK truncated to 1000 chars");

  // English: truncates at 1000 chars, compresses whitespace
  const long = "word ".repeat(100);
  const longResult = extractKeywords(long);
  assert(longResult.length <= 1000, "English truncated to ≤1000 chars");
  assert(!longResult.includes("  "), "no double spaces");

  // Short message passes through
  const short = extractKeywords("Sarah's job");
  assert(short.includes("Sarah's"), "preserves possessive with case");
  assert(short.includes("job"), "keeps 'job'");

  // Empty / whitespace
  assertEqual(extractKeywords("   "), "", "whitespace-only → empty");
}

// ─── extractAttachments Tests ────────────────────────────────

console.log("\n=== extractAttachments Tests ===\n");

// Helper to build a base64 image block
function makeImageBlock(
  b64: string,
  mediaType = "image/png",
): Record<string, unknown> {
  return {
    type: "image",
    source: { type: "base64", data: b64, media_type: mediaType },
  };
}

// Helper to build an OpenClaw-format image block (flat data + mimeType)
function makeOpenClawImageBlock(
  b64: string,
  mimeType = "image/jpeg",
): Record<string, unknown> {
  return { type: "image", data: b64, mimeType };
}

// Helper to build an OpenClaw-format document block
function makeOpenClawDocBlock(
  b64: string,
  mimeType = "application/pdf",
): Record<string, unknown> {
  return { type: "document", data: b64, mimeType };
}

// Helper to build a base64 document block
function makeDocBlock(
  b64: string,
  mediaType = "application/pdf",
): Record<string, unknown> {
  return {
    type: "document",
    source: { type: "base64", data: b64, media_type: mediaType },
  };
}

const smallB64 = Buffer.from("test").toString("base64"); // "dGVzdA=="

// 1. Empty/invalid input
{
  const empty = extractAttachments([]);
  assertEqual(empty.length, 0, "empty array → 0 attachments");

  const fromNull = extractAttachments(null);
  assertEqual(fromNull.length, 0, "null → 0 attachments");
}

// 2. Single image extraction
{
  const result = extractAttachments([makeImageBlock(smallB64, "image/png")]);
  assertEqual(result.length, 1, "single image → 1 attachment");
  assertEqual(
    result[0].fileName,
    "image_1.png",
    "image fileName is image_1.png",
  );
  assertEqual(result[0].mimeType, "image/png", "image mimeType is image/png");
  assertEqual(
    result[0].data.toString(),
    "test",
    "image data decodes to 'test'",
  );
}

// 3. Single document extraction
{
  const result = extractAttachments([
    makeDocBlock(smallB64, "application/pdf"),
  ]);
  assertEqual(result.length, 1, "single document → 1 attachment");
  assertEqual(
    result[0].fileName,
    "document_1.pdf",
    "doc fileName is document_1.pdf",
  );
  assertEqual(
    result[0].mimeType,
    "application/pdf",
    "doc mimeType is application/pdf",
  );
}

// 4. Mixed content — image + text + document → extracts only 2 attachments
{
  const content = [
    makeImageBlock(smallB64),
    { type: "text", text: "hello world" },
    makeDocBlock(smallB64),
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 2, "mixed content → 2 attachments (text skipped)");
  assertEqual(result[0].fileName, "image_1.png", "first is image");
  assertEqual(result[1].fileName, "document_1.pdf", "second is document");
}

// 5. tool_result recursion — nested image inside tool_result
{
  const content = [
    {
      type: "tool_result",
      content: [makeImageBlock(smallB64, "image/jpeg")],
    },
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 1, "tool_result recursion → 1 attachment");
  assertEqual(
    result[0].mimeType,
    "image/jpeg",
    "nested image mimeType correct",
  );
}

// 6. Depth limit — 4 levels deep nesting → stops at depth 3
{
  const content = [
    {
      type: "tool_result",
      content: [
        {
          type: "tool_result",
          content: [
            {
              type: "tool_result",
              content: [
                {
                  type: "tool_result",
                  content: [makeImageBlock(smallB64)],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  const result = extractAttachments(content);
  // depth 0 → depth 1 → depth 2 → depth 3 (processBlock enters with depth=3,
  // sees tool_result at depth=3, recursion depth+1=4 > 3 so stops)
  // Actually: top-level calls processBlock(block, 0). depth=0 tool_result → recurse depth=1
  // depth=1 tool_result → recurse depth=2, depth=2 tool_result → recurse depth=3
  // depth=3 tool_result → tries to recurse depth=4 but `depth > 3` check blocks it.
  // Wait, depth=3 enters processBlock, check `depth > 3` → false (3 is not > 3).
  // So at depth=3, it's a tool_result, tries to recurse nested at depth=4.
  // depth=4 enters processBlock, check `depth > 3` → true, returns immediately.
  // So the image at depth 4 is NOT extracted.
  assertEqual(result.length, 0, "depth 4 nesting → blocked (depth limit 3)");
}

// 7. MAX_ATTACHMENTS cap — 21 image blocks → only 20 extracted
{
  const blocks = [];
  for (let i = 0; i < 21; i++) {
    blocks.push(makeImageBlock(smallB64));
  }
  const result = extractAttachments(blocks);
  assertEqual(result.length, 20, "21 images → capped at 20");
}

// 8. Large file skip — base64 data > ~27MB (decodes to >20MB) → skipped
{
  // 20MB = 20 * 1024 * 1024 = 20971520 bytes
  // base64 length = ceil(bytes * 4/3) ≈ 27962027
  // We need estimatedBytes = ceil(len * 3/4) > 20MB
  // So len > 20971520 * 4/3 ≈ 27962027
  const largeB64 = "A".repeat(28_000_000);
  const result = extractAttachments([makeImageBlock(largeB64)]);
  assertEqual(result.length, 0, "large file (>20MB) → skipped");
}

// 9. Extension sanitization — media_type with special chars
{
  const result = extractAttachments([
    makeImageBlock(smallB64, "image/svg+xml"),
  ]);
  assertEqual(result.length, 1, "svg+xml image → 1 attachment");
  assertEqual(
    result[0].fileName,
    "image_1.svgxml",
    "svg+xml sanitized to svgxml",
  );
}

// 10. OpenClaw format — flat data + mimeType (image)
{
  const result = extractAttachments([
    makeOpenClawImageBlock(smallB64, "image/jpeg"),
  ]);
  assertEqual(result.length, 1, "OpenClaw image → 1 attachment");
  assertEqual(
    result[0].mimeType,
    "image/jpeg",
    "OpenClaw image mimeType correct",
  );
  assertEqual(
    result[0].data.toString(),
    "test",
    "OpenClaw image data decodes correctly",
  );
}

// 11. OpenClaw format — flat data + mimeType (document)
{
  const result = extractAttachments([
    makeOpenClawDocBlock(smallB64, "application/pdf"),
  ]);
  assertEqual(result.length, 1, "OpenClaw doc → 1 attachment");
  assertEqual(
    result[0].mimeType,
    "application/pdf",
    "OpenClaw doc mimeType correct",
  );
}

// 12. OpenClaw mixed — image + text
{
  const content = [
    makeOpenClawImageBlock(smallB64),
    { type: "text", text: "描述这张图片" },
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 1, "OpenClaw mixed → 1 attachment (text skipped)");
}

// 13. Mixed formats — Anthropic + OpenClaw in same array
{
  const content = [
    makeImageBlock(smallB64, "image/png"),
    makeOpenClawImageBlock(smallB64, "image/jpeg"),
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 2, "mixed Anthropic + OpenClaw → 2 attachments");
  assertEqual(result[0].mimeType, "image/png", "first is Anthropic format");
  assertEqual(result[1].mimeType, "image/jpeg", "second is OpenClaw format");
}

// 14. OpenClaw agent_end format — [media attached: /path (mime)]
{
  // Create a temp file to simulate the local media file
  const tmpPath = "/tmp/mimir-test-media-extract.jpg";
  fs.writeFileSync(tmpPath, Buffer.from("fake-jpeg-data"));

  const content = [
    {
      type: "text",
      text: `<memories>some context</memories>\n\n[media attached: ${tmpPath} (image/jpeg) | ${tmpPath}]这是一张测试图片`,
    },
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 1, "agent_end media attached → 1 attachment");
  assertEqual(result[0].mimeType, "image/jpeg", "agent_end mimeType correct");
  assertEqual(
    result[0].data.toString(),
    "fake-jpeg-data",
    "agent_end file data read correctly",
  );

  // Cleanup
  fs.unlinkSync(tmpPath);
}

// 15. agent_end format — file not found → skip silently
{
  const content = [
    {
      type: "text",
      text: "[media attached: /nonexistent/file.jpg (image/jpeg)]",
    },
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 0, "missing file → 0 attachments (no error)");
}

// 16. agent_end format — multiple media in one text block
{
  const tmpPath1 = "/tmp/mimir-test-media-1.jpg";
  const tmpPath2 = "/tmp/mimir-test-media-2.pdf";
  fs.writeFileSync(tmpPath1, Buffer.from("img1"));
  fs.writeFileSync(tmpPath2, Buffer.from("doc1"));

  const content = [
    {
      type: "text",
      text: `[media attached: ${tmpPath1} (image/jpeg) | extra]text[media attached: ${tmpPath2} (application/pdf) | extra]more`,
    },
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 2, "multiple media in text → 2 attachments");
  assertEqual(result[0].mimeType, "image/jpeg", "first is image");
  assertEqual(result[1].mimeType, "application/pdf", "second is document");

  fs.unlinkSync(tmpPath1);
  fs.unlinkSync(tmpPath2);
}

// 17. Dedup: image block + text media ref for same image → only image block extracted
{
  const tmpPath = "/tmp/mimir-test-dedup.jpg";
  fs.writeFileSync(tmpPath, Buffer.from("local-file-data"));

  const content = [
    {
      type: "text",
      text: `[media attached: ${tmpPath} (image/jpeg) | ${tmpPath}]描述`,
    },
    makeOpenClawImageBlock(smallB64, "image/jpeg"),
  ];
  const result = extractAttachments(content);
  assertEqual(result.length, 1, "image block + text ref → 1 (no duplicate)");
  assertEqual(
    result[0].data.toString(),
    "test",
    "kept image block data, not local file",
  );

  fs.unlinkSync(tmpPath);
}

// ─── Formatter Attachment Display Tests ─────────────────────

console.log("\n=== Formatter Attachment Display Tests ===\n");

// 10. Episode with attachments → output includes [files: ...]
{
  const response: SearchResponse = {
    results: [
      {
        id: "ep-att-1",
        type: "episode",
        score: 0.9,
        sources: ["bm25"],
        data: {
          title: "Photo from vacation",
          occurred_at: "2023-08-01T00:00:00Z",
        },
        attachments: [
          {
            id: "a1",
            file_name: "sunset.jpg",
            mime_type: "image/jpeg",
            file_size: 1024,
            signed_url: "https://example.com/sunset.jpg",
            description: "A sunset photo",
            created_at: "2023-08-01T00:00:00Z",
          },
          {
            id: "a2",
            file_name: "notes.pdf",
            mime_type: "application/pdf",
            file_size: 2048,
            signed_url: "https://example.com/notes.pdf",
            description: "Meeting notes",
            created_at: "2023-08-01T00:00:00Z",
          },
        ],
      },
    ],
  };
  const result = formatSearchResults(response);
  assert(
    result.includes(
      "[files: sunset.jpg: https://example.com/sunset.jpg, notes.pdf: https://example.com/notes.pdf]",
    ),
    "episode with attachments shows [files: name: url, ...]",
  );
}

// 11. No attachments → no [files: ] suffix
{
  const response: SearchResponse = {
    results: [
      {
        id: "ep-no-att",
        type: "episode",
        score: 0.9,
        sources: ["bm25"],
        data: {
          title: "Regular memory",
          occurred_at: "2023-08-01T00:00:00Z",
        },
      },
    ],
  };
  const result = formatSearchResults(response);
  assert(!result.includes("[files:"), "no attachments → no [files:] suffix");
}

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
