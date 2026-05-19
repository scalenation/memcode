# MemCode — Project Memory Assistant

> Local-first, durable project memory for coding assistants and developers.

[![CI](https://github.com/memcode/memcode/actions/workflows/ci.yml/badge.svg)](https://github.com/memcode/memcode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## What is MemCode?

MemCode gives coding assistants durable, project-aware memory across sessions and machines. Run one command once — every AI chat in Copilot, Claude, Cursor, and Windsurf automatically receives your latest project context from that point on. No manual steps between sessions.

**Local-first by default. Cloud sync is optional and behind a feature flag.**

## Quick Start

### Free/Local Setup — set up once, forget it

```bash
# Install globally
npm install -g @memcode/cli

# Initialize memory in your project (do this once per repo)
cd my-project
memory init --hooks
```

That's it. MemCode:
- Writes your project context directly into Copilot, Claude, Cursor, and Windsurf config files
- Installs git hooks that auto-refresh context on every commit
- Every new chat session automatically has your latest decisions, tasks, and checkpoints

```bash
# Optional: also auto-refresh on every file save (not just commits)
memory watch start

# Recall a past decision any time
memory recall --query "database choice" --limit 5
```

### Pro Sync Setup

```bash
# Authenticate once per machine
memory sync auth

# Run the universal pull-then-push sync flow
memory sync

# Optional: keep this workspace synced in the background
memory sync start
```

Use `memory sync` for normal hook and background sync. `memory sync push` and `memory sync pull` are manual override commands.

## Features

- **Zero-maintenance context injection** — `memory init --hooks` once; every AI chat in Copilot, Claude, Cursor, and Windsurf automatically gets your latest project context. No action needed between sessions.
- **Automatic checkpoints** — triggered on git commit and branch switch via hooks; context files refreshed in the same step
- **Session-aware context** — imports recent local AI chats and turns them into compact breadcrumbs for the next session
- **Recall** — keyword + recency-ranked search over decisions, tasks, checkpoints
- **Context pack** — manual fallback for tools that don't read config files (e.g. ChatGPT)
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
| `memory init [--hooks]` | Initialize local store, inject context into all agent config files, and install git hooks |
| `memory checkpoint [--note]` | Create a manual checkpoint and refresh all agent context files |
| `memory recall --query <text>` | Ranked recall by keyword |
| `memory context pack` | Manual context block for tools that don't read config files (e.g. ChatGPT) |
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
