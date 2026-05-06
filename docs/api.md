# API Reference — `@memcode/core`

## Database

### `openDb(dbPath: string): Database`

Open (or create) a SQLite database at `dbPath`, run pending migrations, and return
the `better-sqlite3` connection. Configures WAL mode and foreign-key enforcement.

```typescript
import { openDb } from '@memcode/core';
const db = openDb('/path/to/.memory/memory.db');
```

### `appliedMigrations(db: Database): string[]`

Return the names of all applied migrations.

---

## Workspace

### `getOrCreateWorkspace(db, projectPath): Workspace`

Return the existing workspace for `projectPath`, or create one and return it.
Idempotent — safe to call on every command invocation.

### `generateId(): string`

Generate a random 16-character hex ID.

---

## Checkpoints

### `createCheckpoint(db, options): Checkpoint`

Create and persist a checkpoint. The write is wrapped in a SQLite transaction.
A raw event is also appended to `.memory/events.jsonl`.

**Options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workspaceId` | `string` | ✓ | Workspace ID |
| `projectPath` | `string` | ✓ | Absolute path to project root |
| `trigger` | `string` | ✓ | `manual` \| `pre-commit` \| `post-commit` \| `branch-switch` \| `on-save` |
| `note` | `string` | — | Free-text note (redacted before persistence) |
| `sessionId` | `string` | — | Optional session to link to |

### `listCheckpoints(db, workspaceId, limit?): Checkpoint[]`

Return checkpoints for a workspace, newest first.

### `getGitInfo(cwd: string): GitInfo`

Collect git metadata from the working directory. Never throws.

---

## Retrieval

### `recall(db, workspaceId, query, limit?): RecallResult[]`

Recall memory entries matching `query`. Returns up to `limit` results sorted by:

```
score = keyword_score + recency_weight × type_boost
```

**`RecallResult`:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Entry ID |
| `type` | `'decision' \| 'checkpoint' \| 'task'` | Entry type |
| `title` | `string` | Title or summary |
| `detail` | `string` | Extended text |
| `score` | `number` | Composite relevance score |
| `created_at` | `number` | Unix ms |
| `reason` | `string` | Human-readable explanation of why this was returned |

---

## Context Pack

### `generateContextPack(db, workspaceId): string`

Compose a compact Markdown context block including current state, active tasks,
key decisions, and recent activity. Designed to be pasted at the start of a
chat session. Target: < 500 ms.

---

## Timeline

### `getTimeline(db, workspaceId, limit?): TimelineEntry[]`

Return a merged, chronologically sorted list of checkpoints, decisions, and tasks.

---

## Decisions

### `createDecision(db, options): Decision`

Record an architectural or process decision.

| Field | Required |
|-------|----------|
| `workspaceId` | ✓ |
| `title` | ✓ |
| `rationale` | ✓ |
| `impact` | — |
| `checkpointId` | — |

### `listDecisions(db, workspaceId, status?, limit?): Decision[]`

### `updateDecisionStatus(db, id, status): void`

---

## Tasks

### `createTask(db, options): Task`

| Field | Required |
|-------|----------|
| `workspaceId` | ✓ |
| `title` | ✓ |
| `description` | — |
| `priority` | — (`'low' \| 'medium' \| 'high'`) |
| `decisionId` | — |
| `checkpointId` | — |

### `listTasks(db, workspaceId, status?, limit?): Task[]`

### `updateTaskStatus(db, id, status): void`

---

## Redaction

### `redact(text: string): string`

Strip secrets from `text` before persistence. Applied patterns:

- OpenAI, Anthropic, GitHub, Slack, Stripe, Google API keys
- AWS access key IDs and secret keys
- Bearer tokens, JWTs, PEM private keys
- Generic `key=`, `password=`, `secret=`, `token=` assignments
- High-entropy strings (≥ 32 chars, Shannon entropy ≥ 4.5 bits/char) following assignment operators

### `containsSecret(text: string): boolean`

Return `true` if `text` contains a detectable secret.

---

## Git Hooks

### `installGitHooks(projectPath): HookInstallResult`

Install `pre-commit`, `post-commit`, and `post-checkout` hooks.

### `uninstallGitHooks(projectPath): HookName[]`

Remove MemCode blocks from hooks.

### `installedHooks(projectPath): HookName[]`

Return which hooks currently have the MemCode marker.

---

## Cloud Client (`@memcode/cloud-client`)

> **Pro feature** — off by default.

### `encryptPayload(data, keyHex): string`

AES-256-GCM encrypt an object. Returns base64 string.

### `decryptPayload<T>(encoded, keyHex): T`

Decrypt and parse a payload produced by `encryptPayload`.

### `deriveKey(passphrase, workspaceId): string`

Derive a 32-byte encryption key from a passphrase and workspace ID.

### `pushSync(db, config): Promise<PushResult>`

Push workspace summaries to the cloud API (encrypted).

### `pullSync(db, config): Promise<PullResult>`

Pull latest summaries from the cloud API and merge into local DB.
