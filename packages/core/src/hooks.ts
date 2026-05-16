import {
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';

const MEMCODE_MARKER = '# [memcode]';

type HookName = 'pre-commit' | 'post-commit' | 'post-checkout' | 'post-merge';

/**
 * Minimal hook scripts appended to existing hooks (or written fresh).
 *
 * `post-checkout` fires on every branch switch and file checkout; the
 * argument check `[ "$3" = "1" ]` limits it to branch switches only.
 */
const HOOK_SCRIPTS: Record<HookName, string> = {
  'pre-commit': [
    '',
    MEMCODE_MARKER,
    'memory checkpoint --trigger pre-commit 2>/dev/null || true',
  ].join('\n'),

  'post-commit': [
    '',
    MEMCODE_MARKER,
    'memory checkpoint --trigger post-commit 2>/dev/null || true',
    'memory sync 2>/dev/null || true',
  ].join('\n'),

  'post-checkout': [
    '',
    MEMCODE_MARKER,
    '# Only fire on branch switch (not file checkout)',
    'if [ "$3" = "1" ]; then',
    '  memory checkpoint --trigger branch-switch 2>/dev/null || true',
    '  memory sync 2>/dev/null || true',
    'fi',
  ].join('\n'),

  'post-merge': [
    '',
    MEMCODE_MARKER,
    'memory checkpoint --trigger post-merge 2>/dev/null || true',
    'memory sync 2>/dev/null || true',
  ].join('\n'),
};

const SHEBANG = '#!/bin/sh';

// ---------------------------------------------------------------------------

export interface HookInstallResult {
  installed: HookName[];
  skipped: HookName[];
  errors: Array<{ hook: HookName; message: string }>;
}

/**
 * Install MemCode git hooks into `<projectPath>/.git/hooks`.
 *
 * - Existing hooks that already contain the marker have the block replaced
 *   (upgrade in place — ensures stale hooks always get the latest commands).
 * - Existing hooks without the marker have the MemCode block appended.
 * - Missing hooks are created fresh with a `#!/bin/sh` shebang.
 */
export function installGitHooks(projectPath: string): HookInstallResult {
  const hooksDir = join(projectPath, '.git', 'hooks');
  if (!existsSync(hooksDir)) {
    throw new Error(
      `Git hooks directory not found at ${hooksDir}. Is this a git repository?`,
    );
  }

  const installed: HookName[] = [];
  const skipped: HookName[] = [];
  const errors: HookInstallResult['errors'] = [];

  for (const hookName of Object.keys(HOOK_SCRIPTS) as HookName[]) {
    try {
      const hookPath = join(hooksDir, hookName);

      if (existsSync(hookPath)) {
        const existing = readFileSync(hookPath, 'utf-8');
        if (existing.includes(MEMCODE_MARKER)) {
          // Replace the existing MemCode block so stale hooks are upgraded
          const blockStart = existing.indexOf('\n' + MEMCODE_MARKER);
          const before = blockStart >= 0 ? existing.slice(0, blockStart) : existing;
          writeFileSync(hookPath, before + HOOK_SCRIPTS[hookName] + '\n', 'utf-8');
        } else {
          // Append to existing hook
          writeFileSync(hookPath, existing + HOOK_SCRIPTS[hookName] + '\n', 'utf-8');
        }
      } else {
        // Create fresh hook
        writeFileSync(
          hookPath,
          SHEBANG + HOOK_SCRIPTS[hookName] + '\n',
          'utf-8',
        );
      }

      chmodSync(hookPath, 0o755);
      installed.push(hookName);
    } catch (err) {
      errors.push({
        hook: hookName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { installed, skipped, errors };
}

/**
 * Remove the MemCode block from any installed hooks.
 * Returns the list of hook names that were modified.
 */
export function uninstallGitHooks(projectPath: string): HookName[] {
  const hooksDir = join(projectPath, '.git', 'hooks');
  const removed: HookName[] = [];

  for (const hookName of Object.keys(HOOK_SCRIPTS) as HookName[]) {
    const hookPath = join(hooksDir, hookName);
    if (!existsSync(hookPath)) continue;

    const content = readFileSync(hookPath, 'utf-8');
    if (!content.includes(MEMCODE_MARKER)) continue;

    // Remove lines from the marker onward until the next blank-line-separated block
    const lines = content.split('\n');
    const filtered: string[] = [];
    let skip = false;
    for (const line of lines) {
      if (line.startsWith(MEMCODE_MARKER)) {
        skip = true;
        continue;
      }
      // Stop skipping after a blank line following the injected block
      if (skip && line.trim() === '') {
        skip = false;
        continue;
      }
      if (!skip) filtered.push(line);
    }

    const cleaned = filtered.join('\n').trimEnd();
    if (cleaned && cleaned !== SHEBANG) {
      writeFileSync(hookPath, cleaned + '\n', 'utf-8');
    } else {
      // Hook was empty aside from our block — remove it
      const { unlinkSync } = require('node:fs') as typeof import('node:fs');
      try {
        unlinkSync(hookPath);
      } catch {
        // best effort
      }
    }

    removed.push(hookName);
  }

  return removed;
}

/**
 * Return which hooks currently have the MemCode marker installed.
 */
export function installedHooks(projectPath: string): HookName[] {
  const hooksDir = join(projectPath, '.git', 'hooks');
  return (Object.keys(HOOK_SCRIPTS) as HookName[]).filter((hookName) => {
    const hookPath = join(hooksDir, hookName);
    if (!existsSync(hookPath)) return false;
    try {
      return readFileSync(hookPath, 'utf-8').includes(MEMCODE_MARKER);
    } catch {
      return false;
    }
  });
}
