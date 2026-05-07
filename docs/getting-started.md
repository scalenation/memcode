# Getting Started

## Prerequisites

- **Node.js** ≥ 22.15
- **pnpm** ≥ 8 (`npm install -g pnpm`)
- **Git** repository (optional but recommended for automatic hooks)

## 1. Install the CLI

```bash
npm install -g @memcode/cli
# or
pnpm add -g @memcode/cli
```

Verify the install:

```bash
memory --version
```

## 2. Initialize a project

Navigate to your project root and run:

```bash
cd my-project
memory init --hooks
```

This will:

- Create `.memory/` directory with `memory.db` (SQLite) and `config.json`
- Add `.memory/memory.db` and `.memory/events.jsonl` to `.gitignore`
- Install git hooks for automatic checkpointing on commit and branch switch

## 3. Create your first checkpoint

```bash
memory checkpoint --note "Initial setup complete"
```

## 4. Record a decision

```bash
memory decision add \
  --title "Use SQLite for local storage" \
  --rationale "Keeps the tool footprint small, no server required" \
  --impact "All memory operations use Node.js built-in SQLite — zero native deps"
```

## 5. Add a task

```bash
memory task add \
  --title "Add full-text search support" \
  --priority medium
```

## 6. Recall prior context

```bash
memory recall --query "database storage"
```

## 7. Generate a context pack for a new chat session

```bash
memory context-pack
# or copy to clipboard:
memory context-pack --copy
```

Paste the output at the start of your chat session to hydrate the assistant with project context.

## 8. View the timeline

```bash
memory timeline --limit 20
```

## 9. Run the doctor

```bash
memory doctor
```

The doctor validates that the DB is healthy, migrations are current, hooks are wired, and
`.gitignore` is correct.

## VS Code Extension

Install from the VS Code Marketplace (search "MemCode") or press `Ctrl+P` and run:

```
ext install memcode.memcode-vscode
```

Then open the Command Palette (`Ctrl+Shift+P`) and use any `Memory:` command.

The status bar will show memory freshness (e.g. `⬤ Memory (5m ago)`).

## Automatic checkpoints

When installed with `--hooks`, checkpoints are created automatically on:

| Event | Trigger label |
|-------|--------------|
| `git commit` (pre) | `pre-commit` |
| `git commit` (post) | `post-commit` |
| `git checkout <branch>` | `branch-switch` |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `MEMCODE_CLOUD_ENABLED=1` | Enable cloud sync feature flag |
| `NO_COLOR=1` | Disable ANSI colour output |

## Demo

Run the full demo flow from a clean directory:

```bash
bash scripts/demo.sh
```

## Next steps

- [Architecture](./architecture.md) — how the packages fit together
- [API Reference](./api.md) — `@memcode/core` public API
- [Contributing](../CONTRIBUTING.md) — how to contribute
