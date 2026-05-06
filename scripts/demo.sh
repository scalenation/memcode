#!/usr/bin/env bash
# MemCode demo flow — runs a complete round-trip from init to context-pack.
# Usage: bash scripts/demo.sh
set -euo pipefail

DEMO_DIR="$(mktemp -d)/memcode-demo"
CLI="$(cd "$(dirname "$0")/.." && pwd)/packages/cli/dist/index.js"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: CLI not built. Run 'pnpm build' first."
  exit 1
fi

MEMORY="node $CLI"

echo ""
echo "============================================================"
echo "  MemCode Demo"
echo "  Demo directory: $DEMO_DIR"
echo "============================================================"
echo ""

# 1. Create a fake project
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"
git init --quiet
echo "# Demo Project" > README.md
git add README.md
git config user.email "demo@memcode.dev"
git config user.name "Demo User"
git commit -m "Initial commit" --quiet

echo "[ 1/8 ] Initializing memory..."
$MEMORY init --hooks

echo ""
echo "[ 2/8 ] Creating first checkpoint..."
$MEMORY checkpoint --note "Project scaffolded with README"

echo ""
echo "[ 3/8 ] Adding a decision..."
$MEMORY decision add \
  --title "Use SQLite for local storage" \
  --rationale "No server required, perfect for local-first tool" \
  --impact "All data access goes through better-sqlite3"

echo ""
echo "[ 4/8 ] Adding tasks..."
$MEMORY task add --title "Implement full-text search" --priority medium
$MEMORY task add --title "Write onboarding docs" --priority high
$MEMORY task add --title "Set up CI pipeline" --priority low

echo ""
echo "[ 5/8 ] Simulating a commit checkpoint..."
echo "some change" > change.txt
git add change.txt
git commit -m "Add change.txt" --quiet
# The post-commit hook would fire here; simulate manually:
$MEMORY checkpoint --trigger post-commit

echo ""
echo "[ 6/8 ] Recalling context about 'storage'..."
$MEMORY recall --query "storage" --limit 5

echo ""
echo "[ 7/8 ] Viewing timeline..."
$MEMORY timeline --limit 10

echo ""
echo "[ 8/8 ] Generating context pack..."
echo "---"
$MEMORY context-pack
echo "---"

echo ""
echo "[ Doctor check ]"
$MEMORY doctor

echo ""
echo "============================================================"
echo "  Demo complete!"
echo "  Demo data is in: $DEMO_DIR"
echo "  Run 'rm -rf $DEMO_DIR' to clean up."
echo "============================================================"
echo ""
