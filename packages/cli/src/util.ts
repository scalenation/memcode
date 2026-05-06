import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, getOrCreateWorkspace } from '@memcode/core';
import type Database from 'better-sqlite3';
import type { Workspace } from '@memcode/core';

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
export function openProjectDb(projectPath: string): Database.Database {
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
 */
export function resolveProject(cwd?: string): {
  projectPath: string;
  db: Database.Database;
  workspace: Workspace;
} {
  const projectPath = findProjectRoot(cwd ?? process.cwd());
  const db = openProjectDb(projectPath);
  const workspace = getOrCreateWorkspace(db, projectPath);
  return { projectPath, db, workspace };
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
