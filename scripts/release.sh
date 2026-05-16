#!/usr/bin/env bash
# Package release script — bumps one workspace package, validates it, commits, and tags it.
# Usage: bash scripts/release.sh <cli|core|cloud-client|vscode-extension> [patch|minor|major] [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-}"
BUMP="${2:-patch}"
DRY_RUN=0

if [[ "${3:-}" == "--dry-run" ]] || [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  if [[ "${2:-}" == "--dry-run" ]]; then
    BUMP="patch"
  fi
fi

usage() {
  echo "Usage: bash scripts/release.sh <cli|core|cloud-client|vscode-extension> [patch|minor|major] [--dry-run]"
}

if [[ -z "$TARGET" ]]; then
  usage
  exit 1
fi

if [[ "$TARGET" == "patch" || "$TARGET" == "minor" || "$TARGET" == "major" ]]; then
  echo "ERROR: The package target must come first."
  usage
  exit 1
fi

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "ERROR: Invalid bump type '$BUMP'."
  usage
  exit 1
fi

case "$TARGET" in
  cli)
    PACKAGE_DIR="packages/cli"
    PACKAGE_NAME="@memcode/cli"
    TAG_PREFIX="cli"
    ;;
  core)
    PACKAGE_DIR="packages/core"
    PACKAGE_NAME="@memcode/core"
    TAG_PREFIX="core"
    ;;
  cloud-client)
    PACKAGE_DIR="packages/cloud-client"
    PACKAGE_NAME="@memcode/cloud-client"
    TAG_PREFIX="cloud-client"
    ;;
  vscode-extension)
    PACKAGE_DIR="packages/vscode-extension"
    PACKAGE_NAME="memcode-vscode"
    TAG_PREFIX="vscode-extension"
    ;;
  *)
    echo "ERROR: Unknown package target '$TARGET'."
    usage
    exit 1
    ;;
esac

PACKAGE_JSON="$PACKAGE_DIR/package.json"

if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "ERROR: Missing package.json at $PACKAGE_JSON"
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./$PACKAGE_JSON').version")
NEW_VERSION=$(node -e "
  const parts = '$CURRENT_VERSION'.split('.').map(Number);
  if ('$BUMP' === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if ('$BUMP' === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  process.stdout.write(parts.join('.'));
")
TAG_NAME="$TAG_PREFIX-v$NEW_VERSION"

echo "==> Target package: $PACKAGE_NAME"
echo "==> Version bump:   $CURRENT_VERSION -> $NEW_VERSION"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> Dry run:        enabled"
fi

echo "==> Checking for uncommitted changes..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "WARN: Uncommitted changes detected. Continuing because --dry-run was requested."
  else
    echo "ERROR: Uncommitted changes detected. Commit or stash before releasing."
    exit 1
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ""
  echo "==> Skipping build/test/typecheck in dry-run mode."
  echo "==> Dry run complete. No files changed."
  echo "    Would update: $PACKAGE_JSON"
  echo "    Would commit: chore($TARGET): release v$NEW_VERSION"
  echo "    Would tag:    $TAG_NAME"
  exit 0
fi

echo "==> Running full build..."
pnpm build

echo "==> Running tests..."
pnpm test

echo "==> Running typecheck..."
pnpm typecheck

echo "==> Bumping package version..."
node -e "
  const fs = require('fs');
  const path = '$PACKAGE_JSON';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

echo "==> Creating release commit and tag..."
git add "$PACKAGE_JSON"
git commit -m "chore($TARGET): release v$NEW_VERSION"
git tag "$TAG_NAME"

echo ""
echo "==> Ready to publish!"
echo "    Run the following to push and publish:"
echo "      git push origin $(git branch --show-current)"
echo "      git push origin $TAG_NAME"
echo "      cd $PACKAGE_DIR && npm publish --access public"
echo ""
