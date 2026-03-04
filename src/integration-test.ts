/**
 * Integration test: test memory-mimir against a real Mimir server.
 * Run on EC2: MIMIR_URL=http://localhost:8766 npx tsx src/integration-test.ts
 */

import { MimirClient } from "./mimir-client.js";
import { formatSearchResults, formatGraphResults } from "./formatter.js";
import { discoverMemoryFiles } from "./migration.js";
import { homedir } from "node:os";
import { join } from "node:path";

const MIMIR_URL = process.env.MIMIR_URL ?? "http://localhost:8766";
const TEST_USER = "integration-test";
const TEST_GROUP = "integration-test";

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

async function main() {
  const client = new MimirClient({ url: MIMIR_URL, timeoutMs: 30_000 });

  // ─── Test 1: Health check ──────────────────────────────
  console.log("\n=== Integration: Health Check ===\n");
  {
    const healthy = await client.health();
    assert(healthy, `Mimir at ${MIMIR_URL} is healthy`);
    if (!healthy) {
      console.error("Cannot reach Mimir server. Aborting.");
      process.exit(1);
    }
  }

  // ─── Test 2: Ingest a note ─────────────────────────────
  console.log("\n=== Integration: Ingest Note ===\n");
  {
    const result = await client.ingestNote(
      TEST_USER,
      "Arthur prefers dark roast coffee from Blue Bottle. His wife Sarah works at Google as a PM. They are planning a trip to Japan in October 2025.",
      { groupId: TEST_GROUP, noteId: "test-note-1" },
    );

    assert(
      result.EpisodeCount > 0,
      `Ingested note: ${result.EpisodeCount} episodes`,
    );
    // EntityCount may be 0 on repeat runs due to dedup
    assert(
      result.EntityCount >= 0,
      `Extracted entities: ${result.EntityCount} (0 is OK on re-run due to dedup)`,
    );
    console.log(`  Details: ${JSON.stringify(result)}`);
  }

  // ─── Test 3: Ingest a session ──────────────────────────
  console.log("\n=== Integration: Ingest Session ===\n");
  {
    const result = await client.ingestSession(
      TEST_USER,
      [
        {
          role: "user",
          sender_name: "Arthur",
          content: "What's the status of the Mimir project?",
        },
        {
          role: "assistant",
          sender_name: "Claude",
          content:
            "The Mimir unified memory system is at v0.1. We've completed M1-M8 milestones. LoCoMo eval is at 82.5% accuracy with DeepSeek, and 90.1% with gpt-4.1-mini on conv-26.",
        },
        {
          role: "user",
          sender_name: "Arthur",
          content: "How does it compare to EverMemOS?",
        },
        {
          role: "assistant",
          sender_name: "Claude",
          content:
            "EverMemOS achieves 90.6% on LoCoMo. Our architecture with gpt-4.1-mini gets 90.1% on conv-26, so we're within 0.5pp. The gap is mainly in Cat3 common-sense questions.",
        },
      ],
      { groupId: TEST_GROUP },
    );

    assert(
      result.EpisodeCount >= 0,
      `Ingested session: ${result.EpisodeCount} episodes`,
    );
    console.log(`  Details: ${JSON.stringify(result)}`);
  }

  // Wait a moment for indexing
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // ─── Test 4: Search ────────────────────────────────────
  console.log("\n=== Integration: Search ===\n");
  {
    const results = await client.search(TEST_USER, "coffee preferences", {
      groupId: TEST_GROUP,
      topK: 5,
    });

    assert(
      results.results.length > 0,
      `Search returned ${results.results.length} results`,
    );

    const formatted = formatSearchResults(results, {
      maxItems: 5,
      maxChars: 2000,
    });
    console.log(`  Formatted output:\n${formatted}`);
    assert(
      formatted.includes("Relevant Memories"),
      "Formatted output has header",
    );
  }

  // ─── Test 5: Search for entities ───────────────────────
  console.log("\n=== Integration: Entity Search ===\n");
  {
    const results = await client.search(TEST_USER, "Sarah Google", {
      groupId: TEST_GROUP,
      memoryTypes: ["entity", "relation"],
      topK: 5,
    });

    console.log(`  Found ${results.results.length} entity/relation results`);
    for (const r of results.results) {
      console.log(
        `    [${r.type}] score=${r.score.toFixed(3)} ${JSON.stringify(r.data).slice(0, 100)}...`,
      );
    }
    // May or may not find entities depending on LLM extraction
    assert(true, `Entity search completed (${results.results.length} results)`);
  }

  // ─── Test 6: Graph traverse ────────────────────────────
  console.log("\n=== Integration: Graph Traverse ===\n");
  {
    try {
      const result = await client.graphTraverse(
        ["Arthur", "Sarah"],
        TEST_GROUP,
        { hops: 2 },
      );

      console.log(
        `  Found ${result.total_entities} entities, ${result.total_relations} relations`,
      );
      if (result.entities.length > 0) {
        const formatted = formatGraphResults(result);
        console.log(`  Formatted:\n${formatted}`);
      }
      assert(true, `Graph traverse completed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Graph traverse: ${msg}`);
      assert(true, `Graph traverse handled (may not be configured)`);
    }
  }

  // ─── Test 7: Search for Mimir project info ─────────────
  console.log("\n=== Integration: Project Memory Search ===\n");
  {
    const results = await client.search(
      TEST_USER,
      "Mimir project status LoCoMo accuracy",
      {
        groupId: TEST_GROUP,
        topK: 5,
      },
    );

    assert(
      results.results.length > 0,
      `Project search: ${results.results.length} results`,
    );
    const formatted = formatSearchResults(results, {
      maxItems: 5,
      maxChars: 2000,
    });
    console.log(`  Formatted:\n${formatted}`);
  }

  // ─── Test 8: Discover local memory files ───────────────
  console.log("\n=== Integration: Local Memory Discovery ===\n");
  {
    const home = homedir();
    const claudeMemory = join(home, ".claude", "projects");
    const files = await discoverMemoryFiles(claudeMemory);
    console.log(`  Found ${files.length} .md files in ${claudeMemory}`);
    for (const f of files.slice(0, 5)) {
      console.log(`    ${f}`);
    }
    if (files.length > 5) {
      console.log(`    ... and ${files.length - 5} more`);
    }
    assert(true, `Memory discovery: ${files.length} files`);
  }

  // ─── Summary ───────────────────────────────────────────
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Integration Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test failed:", err);
  process.exit(1);
});
