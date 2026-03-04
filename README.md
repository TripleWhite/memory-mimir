# memory-mimir

OpenClaw plugin that connects to [Mimir](https://github.com/TripleWhite/Mimir-Go) — a unified long-term memory engine. Gives your OpenClaw agent persistent, searchable memory across sessions.

## How It Works

```
User message → auto-recall (search Mimir) → inject <memories> → Agent runs → auto-capture (ingest new messages)
```

**Auto-recall**: Before each agent turn, extracts keywords from the user message (supports English + CJK), searches Mimir with agentic retrieval, and injects the most relevant memories into the LLM context.

**Auto-capture**: After each agent turn, incrementally captures new conversation messages and sends them to Mimir for extraction (episodes, entities, relations, events).

## Features

- Agentic search with query classification and strategy routing
- CJK (Chinese/Japanese/Korean) keyword extraction
- Time range extraction from natural language ("last week", "昨天")
- Score-ordered compact memory formatting (2000 char budget)
- Incremental capture — no duplicate ingestion across agent turns
- Two tool definitions: `mimir_search` and `mimir_ingest` for manual use

## Setup

### Prerequisites

A running [Mimir](https://github.com/TripleWhite/Mimir-Go) server.

### Install

```bash
npm install
npm run build
```

### Configure

In your OpenClaw plugin config:

```json
{
  "mimirUrl": "http://localhost:8766",
  "userId": "your-user-id",
  "groupId": "your-group-id",
  "autoRecall": true,
  "autoCapture": true,
  "maxRecallItems": 8,
  "maxRecallTokens": 2000
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mimirUrl` | string | — | Mimir server URL |
| `userId` | string | — | User ID for memory isolation |
| `groupId` | string | — | Group ID for memory scoping |
| `autoRecall` | boolean | `true` | Inject memories before each turn |
| `autoCapture` | boolean | `true` | Capture conversations after each turn |
| `maxRecallItems` | number | `8` | Max memory items per recall |
| `maxRecallTokens` | number | `2000` | Max chars for memory context |

## Architecture

```
memory-mimir (this plugin)          Mimir-Go (engine)
┌─────────────────────┐            ┌──────────────────────┐
│  extractKeywords()  │            │  Agentic Search      │
│  extractTimeRange() │──search──→ │  ├─ Query Analyzer   │
│  formatResults()    │←─results── │  ├─ BM25 + Vector    │
│                     │            │  └─ Graph Traverse   │
│  auto-capture       │──ingest──→ │  Pipeline            │
│  (incremental)      │            │  ├─ Narrative Extract │
│                     │            │  └─ Graph Extract    │
└─────────────────────┘            └──────────────────────┘
```

## Development

```bash
# Run tests
npm test

# Build
npm run build
```

## License

MIT
