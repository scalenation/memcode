# Architecture

## Overview

MemCode is a monorepo with four packages:

```
packages/
  core/             # Domain logic — no I/O beyond SQLite
  cli/              # Commander-based terminal interface + optional local service
  vscode-extension/ # VS Code integration layer
  cloud-client/     # Optional encrypted cloud sync (Pro)
```

The product boundary is intentionally split in two layers:

- Free/local: SQLite-backed memory, git hooks, transcript hydration, context injection files, recall, timeline, optional local service.
- Pro: encrypted cloud sync, hosted semantic retrieval, cross-machine continuity, and future team memory features.

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Event sources                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ CLI cmd  │  │ git hook │  │ VS Code  │  │ local     │  │
│  │ memory   │  │ pre/post │  │ command  │  │ service   │  │
│  │ checkpoint│  │ checkout │  │ palette  │  │ + import  │  │
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
                    │  │ Session store │  │  ← imported local chats
                    │  └──────┬───────┘  │
                    │  ┌──────▼───────┐  │
                    │  │ Local service │  │  ← optional daemon + HTTP API
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

Today, `@memcode/core` is the stable storage and retrieval layer. It now supports both explicit project memory items and imported AI session/message history, which allows MemCode to build progressive, session-aware context for both on-demand commands and the optional local service.

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
| `context-pack.ts` | Context block composition with recent session breadcrumbs |
| `timeline.ts` | Merged chronological event view |
| `hooks.ts` | Git hook installer/uninstaller |
| `items.ts` | Decision and task CRUD |

### `@memcode/cli`

Commander-based CLI. Each command lives in `src/commands/`. Commands open the
DB, call core functions, and print formatted output.

The CLI is also the current orchestration layer for local memory hydration:

- `memory checkpoint` refreshes assistant context files.
- `memory context-pack` imports local chat transcripts before generating prompt context.
- `memory copilot setup` and `memory copilot refresh` write auto-injected context into `CLAUDE.md` and `.github/copilot-instructions.md`.
- `memory service` runs the optional always-on local worker and viewer endpoints.

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

This is the main place where MemCode diverges from claude-mem in a good way for productization: the same local database powers both free and Pro, while Pro adds continuity and retrieval depth instead of replacing the local workflow.

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

## Current Memory Pipeline

```text
Git hooks / CLI / editor transcripts
  -> SQLite (checkpoints, decisions, tasks, sessions, messages)
  -> context-pack generation
  -> CLAUDE.md / copilot-instructions.md injection
  -> optional encrypted cloud sync (Pro)
```

This is intentionally local-first. Synchronous commands still work on demand, and the optional local service adds an always-on layer for background refresh and local HTTP retrieval.

## Claud​​e-Mem Patterns We Are Adopting

Claude-mem gets several architectural choices right. MemCode should absorb these patterns while keeping its local-first and commercial split intact:

1. Hook-driven capture instead of relying only on manual commands.
2. Progressive disclosure in injected context instead of dumping raw history.
3. Graceful degradation: memory failures should never block the host assistant.
4. Clean free/pro layering where Pro extends local memory rather than forking the architecture.

MemCode now implements the first three steps of that direction in local form:

1. Assistant-specific context adapters for Copilot and Claude-managed files.
2. A lightweight local background worker via `memory service`.
3. Local HTTP endpoints and a small viewer over the same SQLite store.

The next recommended step is to keep hosted semantic search and team features in Pro without replacing the local architecture.

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

## Free vs Pro

| Capability | Free / Local | Pro |
|-----------|---------------|-----|
| Checkpoints, tasks, decisions | Yes | Yes |
| Local session/message import | Yes | Yes |
| Context injection into assistant instruction files | Yes | Yes |
| Keyword recall and timeline | Yes | Yes |
| Local always-on worker and viewer | Yes | Yes |
| Cloud sync across machines | No | Yes |
| Hosted semantic recall | No | Yes |
| Team memory / shared workspaces | No | Yes |
| Cross-project insights | Planned local basics | Advanced hosted |
