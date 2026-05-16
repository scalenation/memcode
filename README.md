# MemCode — Project Memory Assistant

> Local-first, durable project memory for coding assistants and developers.

[![CI](https://github.com/memcode/memcode/actions/workflows/ci.yml/badge.svg)](https://github.com/memcode/memcode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## What is MemCode?

MemCode gives coding assistants durable, project-aware memory across sessions and machines. Chat sessions are ephemeral — MemCode captures checkpoints automatically, lets you recall decisions and tasks instantly, and generates a context pack for any new session.

**Local-first by default. Cloud sync is optional and behind a feature flag.**

## Quick Start

```bash
# Install globally
npm install -g @memcode/cli

# Initialize memory in your project
cd my-project
memory init --hooks

# Create a checkpoint
memory checkpoint --note "Switched to PostgreSQL for better full-text search"

# Generate a context pack before a new chat session
memory context-pack

# Recall a past decision
memory recall --query "database choice" --limit 5
```

## Features

- **Automatic checkpoints** — triggered on git commit and branch switch via hooks
- **Session-aware context** — imports recent local AI chats and turns them into compact breadcrumbs for the next session
- **Recall** — keyword + recency-ranked search over decisions, tasks, checkpoints
- **Context pack** — one-command, <500 ms project context block for chat hydration
- **Optional local dashboard** — always-on local worker for assistant refresh, recall, browse endpoints, saved filters, and simple activity views
- **Timeline** — chronological view of all memory events
- **Decision log** — record architectural and process decisions with rationale
- **Task tracking** — link tasks to decisions and checkpoints
- **Secret redaction** — API keys, tokens, private keys stripped before persistence
- **VS Code extension** — palette commands, status bar, auto-checkpoint on save/commit
- **Optional cloud sync** — Pro tier, off by default, encrypted in transit

## Packages

| Package | Description |
|---------|-------------|
| [`@memcode/core`](./packages/core) | Schema, migrations, checkpoint engine, retrieval, redaction |
| [`@memcode/cli`](./packages/cli) | CLI commands (`memory init`, `memory checkpoint`, …) |
| [`memcode-vscode`](./packages/vscode-extension) | VS Code extension with palette commands and status bar |
| [`@memcode/cloud-client`](./packages/cloud-client) | Optional encrypted cloud sync (Pro) |

## CLI Commands

| Command | Description |
|---------|-------------|
| `memory init [--hooks]` | Initialize local store and optionally install git hooks |
| `memory checkpoint [--note]` | Create a manual checkpoint |
| `memory recall --query <text>` | Ranked recall by keyword |
| `memory context-pack` | Print context block for chat hydration, including recent imported AI sessions |
| `memory service start` | Start the local background worker and local dashboard service |
| `memory timeline` | List recent events |
| `memory decision add` | Record an architectural decision |
| `memory task add` | Create a task |
| `memory sync` | Universal cloud sync: pull latest cloud memory, then push local state (Pro) |
| `memory sync push` | Explicit push-only cloud sync (Pro) |
| `memory sync pull` | Explicit pull-only cloud sync (Pro) |
| `memory doctor` | Validate setup and hook wiring |

## VS Code Commands

Open the Command Palette (`Ctrl+Shift+P`) and type `Memory:`:

- **Memory: Refresh Context** — reload latest checkpoint
- **Memory: Create Checkpoint** — manual checkpoint with note
- **Memory: Show Timeline** — webview timeline
- **Memory: Recall** — QuickPick recall query
- **Memory: Add Decision** — record a decision from the editor
- **Memory: Add Task** — create a task
- **Memory: Inject Context Into Chat** — paste context pack into chat
- **Memory: Sync Now** — trigger cloud sync (Pro)

## Development

```bash
# Prerequisites: Node >= 18, pnpm >= 8
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor guide.

## Architecture

See [docs/architecture.md](./docs/architecture.md) for a detailed breakdown of the data flow, package boundaries, and extension model.

MemCode’s direction is now explicitly split into:

- Free/local memory: SQLite, checkpoints, transcript hydration, assistant context injection, keyword recall, local dashboard browsing, saved filters, and simple activity views.
- Pro memory: encrypted cloud sync, hosted semantic recall, and cross-machine continuity on top of the same local store.

## Security

See [SECURITY.md](./SECURITY.md) for the vulnerability disclosure policy and the built-in redaction rules.

## License

MIT — see [LICENSE](./LICENSE).
