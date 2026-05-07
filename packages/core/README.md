# @memcode/core

> Core library for MemCode — SQLite schema, migrations, checkpoint engine, semantic retrieval, and secret redaction.

[![npm version](https://img.shields.io/npm/v/@memcode/core)](https://www.npmjs.com/package/@memcode/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/scalenation/memcode/blob/master/LICENSE)
[![Node.js ≥ 22.15](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-scalenation%2Fmemcode-blue?logo=github)](https://github.com/scalenation/memcode)

---

## What is this package?

`@memcode/core` is the engine behind the [`@memcode/cli`](https://www.npmjs.com/package/@memcode/cli) tool. It provides:

- **Zero-dependency SQLite storage** — built on `node:sqlite` (Node.js 22 built-in, no native addons)
- **Auto-migrations** — the database is created and migrated on first `openDb()` call
- **Checkpoint engine** — snapshot project state with file-tree diffs and event metadata
- **Retrieval** — keyword-ranked search over decisions, tasks, and checkpoints
- **Context pack generation** — compact, formatted summary block for chat hydration
- **Secret redaction** — strips API keys, tokens, PEM blocks, and connection strings before storage

Most users should install the CLI instead:

```bash
npm install -g @memcode/cli
```

Use this package directly if you're building integrations, VS Code extensions, or embedding memory into your own tools.

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 22.15.0 (requires `node:sqlite` built-in) |

---

## Installation

```bash
npm install @memcode/core
```

---

## API Reference

### Database

#### `openDb(dbPath: string): DatabaseSync`

Open (or create) the SQLite database at `dbPath`. Runs all pending migrations automatically.

```ts
import { openDb } from '@memcode/core';

const db = openDb('/path/to/.memory/memory.db');
```

---

### Workspace

#### `getOrCreateWorkspace(db, projectPath: string): Workspace`

Return the workspace row, creating it if it doesn't exist. The workspace `id` is a UUID tied to the project path.

```ts
import { openDb, getOrCreateWorkspace } from '@memcode/core';

const db = openDb(dbPath);
const workspace = getOrCreateWorkspace(db, process.cwd());
console.log(workspace.id); // UUID
```

---

### Checkpoints

#### `createCheckpoint(db, workspaceId: string, note?: string): Checkpoint`

Snapshot the current state and create a checkpoint event.

```ts
import { createCheckpoint } from '@memcode/core';

const cp = createCheckpoint(db, workspace.id, 'Completed auth refactor');
console.log(cp.id, cp.createdAt);
```

#### `listCheckpoints(db, workspaceId: string, limit?: number): Checkpoint[]`

List recent checkpoints, newest first.

---

### Decisions

#### `addDecision(db, workspaceId: string, opts): Decision`

Record an architectural or process decision.

```ts
import { addDecision } from '@memcode/core';

addDecision(db, workspace.id, {
  title: 'Use PostgreSQL for prod',
  rationale: 'Better full-text search than SQLite',
  impact: 'All query helpers need pg-compatible SQL',
});
```

#### `listDecisions(db, workspaceId: string, limit?: number): Decision[]`

List decisions, newest first.

---

### Tasks

#### `addTask(db, workspaceId: string, opts): Task`

Create a task linked to the workspace.

```ts
import { addTask } from '@memcode/core';

addTask(db, workspace.id, {
  title: 'Write integration tests',
  priority: 'high',
});
```

| Priority | Value |
|---|---|
| Low | `'low'` |
| Medium | `'medium'` (default) |
| High | `'high'` |

#### `listTasks(db, workspaceId: string, opts?): Task[]`

```ts
listTasks(db, workspace.id, { status: 'open' });
```

#### `completeTask(db, id: string): void`

Mark a task as done.

---

### Retrieval

#### `recall(db, workspaceId: string, query: string, limit?: number): RecallResult[]`

Keyword-ranked search over checkpoints, decisions, and tasks. Returns results sorted by match score × recency.

```ts
import { recall } from '@memcode/core';

const results = recall(db, workspace.id, 'authentication jwt', 5);
results.forEach(r => console.log(r.type, r.title, r.score));
```

Each `RecallResult`:

```ts
{
  type: 'checkpoint' | 'decision' | 'task';
  id: string;
  title: string;
  body: string;
  score: number;
  createdAt: string; // ISO 8601
}
```

---

### Context Pack

#### `buildContextPack(db, workspaceId: string): string`

Generate the formatted context string for pasting into a chat session.

```ts
import { buildContextPack } from '@memcode/core';

const pack = buildContextPack(db, workspace.id);
console.log(pack);
// === MemCode Context Pack ===
// Project: my-app | Branch: main | Last checkpoint: 1 hour ago
// ...
```

---

### Timeline

#### `getTimeline(db, workspaceId: string, limit?: number): TimelineEvent[]`

All events (checkpoints, decisions, tasks) in reverse-chronological order.

---

### Git Hooks

#### `installGitHooks(projectPath: string): void`

Install `post-commit` and `post-checkout` hooks into `<projectPath>/.git/hooks/`. Safe to call multiple times — overwrites only MemCode-owned hooks.

---

### Redaction

#### `redact(text: string): string`

Strip secret patterns from a string and replace them with `[REDACTED]`. Called automatically before any write.

Patterns detected:

| Category | Examples |
|---|---|
| Generic API keys | `sk-...`, `ghp_...`, `xoxb-...` |
| AWS credentials | `AKIA...`, secret access keys |
| Private key blocks | `-----BEGIN RSA PRIVATE KEY-----` |
| Connection strings | `postgres://user:password@host` |
| `.env` style assignments | `API_KEY=abc123` |

---

## Schema

The SQLite schema (auto-created by `openDb()`):

```sql
workspaces  (id TEXT PK, project_path, created_at)
checkpoints (id TEXT PK, workspace_id→workspaces, note, file_tree_json, created_at)
decisions   (id TEXT PK, workspace_id→workspaces, title, rationale, impact, created_at)
tasks       (id TEXT PK, workspace_id→workspaces, title, priority, status, created_at, completed_at)
events      (id TEXT PK, workspace_id→workspaces, type, payload_json, created_at)
```

---

## TypeScript Types

Key exported types:

```ts
export interface Workspace {
  id: string;
  projectPath: string;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  workspaceId: string;
  note?: string;
  fileTreeJson?: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  workspaceId: string;
  title: string;
  rationale?: string;
  impact?: string;
  createdAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'done';
  createdAt: string;
  completedAt?: string;
}

export interface RecallResult {
  type: 'checkpoint' | 'decision' | 'task';
  id: string;
  title: string;
  body: string;
  score: number;
  createdAt: string;
}
```

---

## Related Packages

| Package | Description |
|---|---|
| [`@memcode/cli`](https://www.npmjs.com/package/@memcode/cli) | CLI tool — the main user-facing interface |
| [`@memcode/cloud-client`](https://www.npmjs.com/package/@memcode/cloud-client) | Encrypted cloud sync client (Pro) |

---

## License

MIT © [MemCode](https://github.com/scalenation/memcode)
