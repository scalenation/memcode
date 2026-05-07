# @memcode/cli

> Durable, local-first project memory for coding assistants — checkpoint your work, recall past decisions, and generate instant context packs for any new chat session.

[![npm version](https://img.shields.io/npm/v/@memcode/cli)](https://www.npmjs.com/package/@memcode/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/scalenation/memcode/blob/master/LICENSE)
[![Node.js ≥ 22.15](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen)](https://nodejs.org/)

---

## What is MemCode?

Coding assistants forget everything when the session ends. MemCode fixes that.

- Run `memory init --hooks` once in any repo.
- Every git commit auto-snapshots your file tree, open tasks, and recent decisions.
- Before a new chat, run `memory context-pack` — one copy-paste hydrates the assistant instantly.
- Recall any past decision with `memory recall --query "why postgres"`.
- **Pro:** Push your encrypted memory to the cloud and pull it on any machine.

All memory lives in a single SQLite file at `.memory/memory.db`. No daemon. No server. No network unless you ask for it.

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 22.15.0 |
| Git | any (optional, for hooks) |

---

## Installation

```bash
npm install -g @memcode/cli
```

Verify:

```bash
memory --version
```

---

## Quick Start

```bash
# 1. Go to any project
cd ~/projects/my-app

# 2. Initialize memory (--hooks wires git commit + branch-switch automatically)
memory init --hooks

# 3. Create a checkpoint
memory checkpoint --note "Switched auth from session cookies to JWTs"

# 4. Record a decision
memory decision add \
  --title "JWT over cookies" \
  --rationale "Stateless, works with our mobile app" \
  --impact "All API routes must validate Bearer tokens"

# 5. Add a task
memory task add --title "Migrate existing sessions" --priority high

# 6. Before your next chat — generate a context pack
memory context-pack
# Paste the output at the top of your next chat window
```

---

## All Commands

### `memory init`

Initialize memory in the current project.

```bash
memory init [options]
```

| Option | Description |
|---|---|
| `--hooks` | Install git hooks for auto-checkpointing on commit and branch switch |
| `--path <path>` | Target directory (defaults to CWD or nearest git root) |

Creates:
- `.memory/memory.db` — SQLite database (gitignored automatically)
- `.memory/config.json` — workspace config
- `.gitignore` entries for memory files

---

### `memory checkpoint`

Create a snapshot of the project state.

```bash
memory checkpoint [options]
```

| Option | Description |
|---|---|
| `--note <text>` | Human-readable description of what happened |
| `--path <path>` | Project path |

When `--hooks` was used at init, this runs automatically on every `git commit`. Manual checkpoints are useful for major milestones.

---

### `memory recall`

Ranked keyword search over all stored memory.

```bash
memory recall [options]
```

| Option | Description |
|---|---|
| `--query <text>` | Search terms (required) |
| `--limit <n>` | Max results (default: 10) |
| `--path <path>` | Project path |

Searches decisions, checkpoints, and tasks. Results are ranked by keyword match + recency.

```bash
memory recall --query "database migration strategy" --limit 5
```

---

### `memory context-pack`

Generate a compact context block for pasting into a chat session.

```bash
memory context-pack [options]
```

| Option | Description |
|---|---|
| `--path <path>` | Project path |

Output includes: workspace metadata, recent checkpoints, open tasks, latest decisions, and a file-tree snapshot. Typically under 2 KB and renders in < 500 ms.

```
=== MemCode Context Pack ===
Project: my-app  |  Branch: feature/auth  |  Last checkpoint: 2 hours ago
...
```

---

### `memory timeline`

Print a chronological list of all memory events.

```bash
memory timeline [options]
```

| Option | Description |
|---|---|
| `--limit <n>` | Max events (default: 20) |
| `--path <path>` | Project path |

---

### `memory decision`

Manage architectural and process decisions.

#### `memory decision add`

```bash
memory decision add [options]
```

| Option | Description |
|---|---|
| `--title <text>` | Short title for the decision (required) |
| `--rationale <text>` | Why this decision was made |
| `--impact <text>` | What changes as a result |
| `--path <path>` | Project path |

#### `memory decision list`

```bash
memory decision list [--path <path>]
```

---

### `memory task`

Manage project tasks linked to memory events.

#### `memory task add`

```bash
memory task add [options]
```

| Option | Description |
|---|---|
| `--title <text>` | Task description (required) |
| `--priority <level>` | `low` \| `medium` \| `high` (default: `medium`) |
| `--path <path>` | Project path |

#### `memory task list`

```bash
memory task list [--status <status>] [--path <path>]
```

| Option | Description |
|---|---|
| `--status <status>` | Filter by `open` \| `done` \| `all` (default: `open`) |

#### `memory task done`

```bash
memory task done <id> [--path <path>]
```

---

### `memory doctor`

Validate your setup: checks database integrity, hook wiring, and config file consistency.

```bash
memory doctor [--path <path>]
```

---

### `memory sync` _(Pro — [memcode.dev/pricing](https://memcode.dev/pricing))_

Encrypted cloud sync across machines. Requires a Pro subscription ($3.99/month, 7-day free trial).

#### `memory sync auth`

Authenticate and save credentials to `~/.config/memcode/auth.json`.

```bash
memory sync auth [--endpoint <url>]
```

Prompts for email, password, and an **encryption passphrase**. The passphrase is never sent to the server — it derives the AES-256-GCM key used to encrypt your memory locally before upload.

> **Important:** There is no passphrase recovery. If you lose it, your cloud data cannot be decrypted.

#### `memory sync push`

Push encrypted memory to the cloud.

```bash
memory sync push [--path <path>]
```

#### `memory sync pull`

Pull and merge cloud memory into the local store.

```bash
memory sync pull [--path <path>]
```

#### `memory sync status`

Show last sync timestamp, cursor, and push count.

```bash
memory sync status [--path <path>]
```

---

## Git Hooks

When initialized with `--hooks`, MemCode installs:

| Hook | What it does |
|---|---|
| `post-commit` | Creates a checkpoint with the commit message and file diff summary |
| `post-checkout` | Creates a checkpoint on branch switch, records the target branch |

Hooks are installed to `.git/hooks/`. They are plain shell scripts — inspect them at any time:

```bash
cat .git/hooks/post-commit
```

---

## File Layout

```
my-project/
├── .memory/
│   ├── memory.db       # SQLite — all checkpoints, decisions, tasks (gitignored)
│   ├── config.json     # Workspace ID and feature flags
│   └── events.jsonl    # Append-only event log (gitignored)
└── .git/
    └── hooks/
        ├── post-commit     # Auto-checkpoint on commit
        └── post-checkout   # Auto-checkpoint on branch switch
```

---

## Security & Redaction

MemCode scans every checkpoint for secrets before storing them. The following patterns are stripped and replaced with `[REDACTED]`:

- API keys and tokens (GitHub, AWS, Stripe, OpenAI, etc.)
- Private keys (PEM/DER blocks)
- Connection strings with embedded credentials
- `.env` file values that look like secrets

The redaction step runs in-process, before write. No secrets leave your machine.

---

## Cloud Sync Security

When cloud sync is enabled:

1. Your encryption passphrase never leaves your machine.
2. The AES-256-GCM key is derived locally: `SHA256(passphrase + ":" + workspaceId)`.
3. Only ciphertext is stored on the server — MemCode servers cannot read your memory.
4. Each push creates a new cursor; the server stores a single latest blob per workspace.

---

## Configuration

`.memory/config.json` controls per-project settings:

```json
{
  "version": 1,
  "workspaceId": "uuid",
  "cloudSync": {
    "enabled": false
  }
}
```

Global auth config lives at `~/.config/memcode/auth.json` (mode `0600`):

```json
{
  "endpoint": "https://api.memcode.dev",
  "apiToken": "...",
  "encryptionPassphrase": "..."
}
```

---

## Upgrading

```bash
npm update -g @memcode/cli
memory doctor   # verify after upgrade
```

---

## Related Packages

| Package | Description |
|---|---|
| [`@memcode/core`](https://www.npmjs.com/package/@memcode/core) | Core library — schema, checkpoint engine, retrieval, redaction |
| [`@memcode/cloud-client`](https://www.npmjs.com/package/@memcode/cloud-client) | Encrypted cloud sync client (used internally by the CLI) |

---

## License

MIT © [MemCode](https://github.com/scalenation/memcode)
