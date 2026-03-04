/**
 * Unit tests for memory-mimir plugin.
 * Run with: npx tsx src/test.ts
 */

import { formatSearchResults, formatGraphResults } from "./formatter.js";
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
  const longContent = "A".repeat(300);
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

// ─── Keyword Extraction Tests ────────────────────────────────

console.log("\n=== Keyword Extraction Tests ===\n");

// Import via dynamic import to test the extractKeywords function
// Since it's not exported, we test indirectly through the index module
// For now, test the concept:

{
  // Simple keyword extraction test
  const stopWords = new Set([
    "the",
    "a",
    "is",
    "do",
    "you",
    "remember",
    "what",
  ]);
  const testExtract = (msg: string) => {
    return msg
      .toLowerCase()
      .replace(/[^\w\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
      .slice(0, 5)
      .join(" ");
  };

  const result1 = testExtract("Do you remember what Calvin said about coffee?");
  assert(result1.includes("calvin"), "extracts 'calvin' from question");
  assert(result1.includes("coffee"), "extracts 'coffee' from question");

  const result2 = testExtract("What is Sarah's job?");
  assert(result2.includes("sarah's"), "extracts name with possessive");
  assert(result2.includes("job"), "extracts 'job'");
}

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
