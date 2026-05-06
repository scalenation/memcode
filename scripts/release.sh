#!/usr/bin/env bash
# Release script — bumps version, builds, runs tests, and publishes.
# Usage: bash scripts/release.sh [patch|minor|major]
set -euo pipefail

BUMP="${1:-patch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Checking for uncommitted changes..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes detected. Commit or stash before releasing."
  exit 1
fi

echo "==> Running full build..."
pnpm build

echo "==> Running tests..."
pnpm test

echo "==> Running typecheck..."
pnpm typecheck

echo "==> Bumping version ($BUMP)..."
# Bump root package version
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  const parts = pkg.version.split('.').map(Number);
  if ('$BUMP' === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if ('$BUMP' === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  pkg.version = parts.join('.');
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('New version: ' + pkg.version);
"

NEW_VERSION=$(node -p "require('./package.json').version")

# Sync version to workspace packages
for PKG in packages/core packages/cli packages/vscode-extension packages/cloud-client; do
  node -e "
    const fs = require('fs');
    const path = '$PKG/package.json';
    if (!fs.existsSync(path)) process.exit(0);
    const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  Updated $PKG to $NEW_VERSION"
done

echo "==> Creating git tag v$NEW_VERSION..."
git add -A
git commit -m "chore: release v$NEW_VERSION"
git tag "v$NEW_VERSION"

echo ""
echo "==> Ready to publish!"
echo "    Run the following to push and publish:"
echo "      git push && git push --tags"
echo "      cd packages/core && npm publish --access public"
echo "      cd packages/cli  && npm publish --access public"
echo ""
