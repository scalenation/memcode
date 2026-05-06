# Contributing to MemCode

Thank you for considering a contribution to MemCode! This guide explains how to set up your environment, submit changes, and meet the definition of done.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Prerequisites](#prerequisites)
- [Repository Setup](#repository-setup)
- [Package Structure](#package-structure)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Commit Style](#commit-style)
- [Pull Request Process](#pull-request-process)
- [Definition of Done](#definition-of-done)

## Code of Conduct

All contributors are expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js** >= 18.0.0
- **pnpm** >= 8.0.0 (`npm install -g pnpm`)
- **Git** >= 2.30

## Repository Setup

```bash
git clone https://github.com/memcode/memcode.git
cd memcode
pnpm install
pnpm build
pnpm test
```

## Package Structure

```
packages/
  core/           # Schema, migrations, checkpoint engine, retrieval, redaction
  cli/            # Commander-based CLI entry point and commands
  vscode-extension/ # VS Code extension (activates in workspace)
  cloud-client/   # Optional cloud sync (Pro tier, off by default)
docs/             # Architecture, API reference, getting-started guide
scripts/          # Release automation and demo script
```

## Development Workflow

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make changes with tests.
3. Run `pnpm build && pnpm test` to validate.
4. Run `pnpm typecheck` to catch type errors.
5. Commit using [Conventional Commits](#commit-style).
6. Open a pull request against `main`.

### Working on `packages/core`

```bash
cd packages/core
pnpm test --watch
```

### Working on `packages/cli`

```bash
cd packages/cli
pnpm build
node dist/index.js --help
```

### Working on the VS Code extension

```bash
cd packages/vscode-extension
pnpm build
# Press F5 in VS Code to launch Extension Development Host
```

## Testing

- Unit tests live in `packages/*/tests/`.
- Run all tests: `pnpm test` (from root).
- Run one package: `cd packages/core && pnpm test`.
- Test framework: **Vitest**.

All new behaviours must have a corresponding test.

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add entropy-based redaction for high-entropy strings
fix(cli): handle missing .memory dir gracefully in recall command
test(core): add retrieval ranking unit tests
docs: update architecture diagram for v1 schema
```

## Pull Request Process

1. Ensure `pnpm build && pnpm test && pnpm typecheck` pass locally.
2. Fill in the PR template.
3. Request review from a maintainer.
4. Address review comments; maintainer merges.

## Definition of Done

A change is done when:

- [ ] All acceptance criteria for the issue pass.
- [ ] Tests added for new behaviours.
- [ ] Documentation updated where applicable.
- [ ] No new critical lint or type errors.
- [ ] Demo flow reproducible from a clean machine (for user-facing features).
- [ ] Changelog entry added.
