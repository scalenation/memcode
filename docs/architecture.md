# Architecture

## Overview

MemCode is a monorepo with four packages:

```
packages/
  core/             # Domain logic — no I/O beyond SQLite
  cli/              # Commander-based terminal interface
  vscode-extension/ # VS Code integration layer
  cloud-client/     # Optional encrypted cloud sync (Pro)
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Event sources                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ CLI cmd  │  │ git hook │  │ VS Code  │  │ on-save   │  │
│  │ memory   │  │ pre/post │  │ command  │  │ debounce  │  │
│  │ checkpoint│  │ checkout │  │ palette  │  │ watcher   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
└───────┼─────────────┼─────────────┼───────────────┼────────┘
        │             │             │               │
        └─────────────┴─────────────┴───────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  @memcode/core     │
                    │  ┌──────────────┐  │
                    │  │  Redaction   │  │  ← strips secrets
                    │  └──────┬───────┘  │
                    │  ┌──────▼───────┐  │
                    │  │  Summarizer  │  │  ← deterministic
                    │  └──────┬───────┘  │
                    │  ┌──────▼───────┐  │
                    │  │  SQLite DB   │  │  ← atomic write
                    │  └──────┬───────┘  │
                    │  ┌──────▼───────┐  │
                    │  │ JSONL archive│  │  ← raw events
                    │  └─────────────┘  │
                    └────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────┐  ┌──────▼──────┐  ┌───▼──────────┐
     │  Retrieval  │  │ Context pack│  │  Timeline    │
     │  (recall)   │  │ composer    │  │  view        │
     └─────────────┘  └─────────────┘  └──────────────┘
```

## Packages

### `@memcode/core`

All domain logic. No dependency on VS Code, Commander, or any HTTP client.

Key modules:

| Module | Responsibility |
|--------|---------------|
| `db.ts` | Open SQLite, run migrations |
| `schema.ts` | TypeScript interfaces matching DB tables |
| `migrations.ts` | Embedded SQL migration strings |
| `workspace.ts` | Workspace record creation and lookup |
| `checkpoint.ts` | Checkpoint creation pipeline |
| `redaction.ts` | Pattern + entropy-based secret stripping |
| `summarizer.ts` | Deterministic short/long summaries |
| `retrieval.ts` | Keyword + recency-decay recall |
| `context-pack.ts` | Context block composition |
| `timeline.ts` | Merged chronological event view |
| `hooks.ts` | Git hook installer/uninstaller |
| `items.ts` | Decision and task CRUD |

### `@memcode/cli`

Commander-based CLI. Each command lives in `src/commands/`. Commands open the
DB, call core functions, and print formatted output.

### `memcode-vscode`

VS Code extension. Activates on startup and:

- Registers 8 palette commands (see extension's `package.json` `contributes`)
- Shows a status bar item with memory freshness
- Watches `.git/COMMIT_EDITMSG` and `.git/HEAD` for automatic checkpoints
- Optionally auto-checkpoints on file save (debounced, opt-in)

### `@memcode/cloud-client`

Optional Pro feature. AES-256-GCM client-side encryption before upload.
Push/pull against a stateless REST API. Merge strategy: last-write-wins on
`updated_at`; checkpoints are append-only.

## SQLite Schema

```
workspaces ──< sessions ──< messages
workspaces ──< checkpoints
workspaces ──< decisions
workspaces ──< tasks
workspaces ──< sync_state
checkpoints ──< artifacts
```

All tables use opaque hex IDs (`randomBytes(8).toString('hex')`).
Timestamps are Unix milliseconds.

## Retrieval Scoring

```
score = keyword_score + recency_weight × type_boost

keyword_score  = matched_keywords / total_query_keywords
recency_weight = exp(−age_days × ln2 / 30)   // 30-day half-life
type_boost     = { decision: 1.5, checkpoint: 1.0, task: 1.0 }
```

## Redaction Pipeline

1. Named-pattern pass (API keys, JWTs, PEM keys, provider-specific tokens)
2. High-entropy context pass (tokens ≥ 32 chars after `=`/`:`, Shannon entropy ≥ 4.5)

## Git Hooks

Installed to `.git/hooks/`:

| Hook | Trigger label |
|------|--------------|
| `pre-commit` | `pre-commit` |
| `post-commit` | `post-commit` |
| `post-checkout` | `branch-switch` (only on branch switch, not file checkout) |

## Extension Model

| Interface | Purpose |
|-----------|---------|
| `SummarizerProvider` | (future) plug in an LLM summariser |
| `RedactionProvider` | (future) custom redaction rules |
| `EmbeddingProvider` | (future) dense vector search |
