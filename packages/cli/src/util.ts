import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, getOrCreateWorkspace } from '@memcode/core';
import type { DatabaseSync } from 'node:sqlite';
import type { Workspace } from '@memcode/core';

interface MemoryConfig {
  version?: number;
  workspaceId?: string;
  workspaceStrategy?: 'git-origin' | 'manual';
  projectKey?: string;
  cloudSync?: { enabled?: boolean };
}

/**
 * Walk up the directory tree from `startDir` until we find a `.memory`
 * directory or `.git` directory, indicating the project root.
 * Falls back to `startDir` if neither is found.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.memory')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return startDir;
    }
    dir = parent;
  }
}

export function getMemoryDir(projectPath: string): string {
  return join(projectPath, '.memory');
}

export function getDbPath(projectPath: string): string {
  return join(projectPath, '.memory', 'memory.db');
}

/**
 * Open the existing project database, throwing a user-friendly error if not
 * yet initialised.
 */
export function openProjectDb(projectPath: string): DatabaseSync {
  const dbPath = getDbPath(projectPath);
  if (!existsSync(dbPath)) {
    throw new Error(
      `No memory database found at ${dbPath}\nRun 'memory init' first.`,
    );
  }
  return openDb(dbPath);
}

/**
 * Convenience: resolve the project root, open the DB, and return the
 * workspace record — all in one call used by most commands.
 *
 * If `.memory/config.json` contains a `workspaceId` that differs from the
 * one in local SQLite (e.g. after cloning on a new machine), this function
 * performs a one-time migration so all local data and future writes use the
 * portable config.json ID.  This ensures that `memory checkpoint`, `memory
 * sync push`, and `memory sync pull` all operate on the same ID.
 */
export function resolveProject(cwd?: string): {
  projectPath: string;
  db: DatabaseSync;
  workspace: Workspace;
} {
  const projectPath = findProjectRoot(cwd ?? process.cwd());
  const db = openProjectDb(projectPath);
  const workspace = reconcileWorkspaceIdentity(db, projectPath, getOrCreateWorkspace(db, projectPath));

  return { projectPath, db, workspace };
}

export function reconcileWorkspaceIdentity(
  db: DatabaseSync,
  projectPath: string,
  workspace: Workspace,
): Workspace {
  const configPath = join(getMemoryDir(projectPath), 'config.json');
  const existingConfig = readMemoryConfig(configPath);
  const gitProjectKey = detectGitProjectKey(projectPath);
  const canonicalId = gitProjectKey
    ? stableWorkspaceId(gitProjectKey)
    : existingConfig.workspaceId ?? workspace.id;

  try {
    if (canonicalId !== workspace.id) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      db.prepare('UPDATE workspaces    SET id           = ? WHERE id           = ?').run(canonicalId, workspace.id);
      db.prepare('UPDATE checkpoints   SET workspace_id = ? WHERE workspace_id = ?').run(canonicalId, workspace.id);
      db.prepare('UPDATE decisions     SET workspace_id = ? WHERE workspace_id = ?').run(canonicalId, workspace.id);
      db.prepare('UPDATE tasks         SET workspace_id = ? WHERE workspace_id = ?').run(canonicalId, workspace.id);
      db.prepare('UPDATE sessions      SET workspace_id = ? WHERE workspace_id = ?').run(canonicalId, workspace.id);
      db.prepare('UPDATE sync_state    SET workspace_id = ? WHERE workspace_id = ?').run(canonicalId, workspace.id);
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys = ON');
      workspace = { ...workspace, id: canonicalId };
    }

    writeMemoryConfig(configPath, {
      ...existingConfig,
      version: 2,
      workspaceId: canonicalId,
      workspaceStrategy: gitProjectKey ? 'git-origin' : existingConfig.workspaceStrategy ?? 'manual',
      projectKey: gitProjectKey ?? existingConfig.projectKey,
      cloudSync: existingConfig.cloudSync ?? { enabled: false },
    });
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* empty */ }
    db.exec('PRAGMA foreign_keys = ON');
  }

  return workspace;
}

/**
 * Format a Unix millisecond timestamp as a short local date + time string.
 */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

/**
 * Truncate a string with an ellipsis if it exceeds `max` characters.
 */
export function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function readMemoryConfig(configPath: string): MemoryConfig {
  try {
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, 'utf-8')) as MemoryConfig;
  } catch {
    return {};
  }
}

function writeMemoryConfig(configPath: string, config: MemoryConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function detectGitProjectKey(projectPath: string): string | null {
  const remote = gitCommand(projectPath, ['config', '--get', 'remote.origin.url']);
  if (!remote) return null;
  const normalizedRemote = normalizeGitRemote(remote);
  return normalizedRemote ? `git:${normalizedRemote}` : null;
}

function gitCommand(projectPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', projectPath, ...args], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function normalizeGitRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^[^@]+@/, '')
    .replace(':', '/')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function stableWorkspaceId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
