import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type Database from 'better-sqlite3';
import type { Workspace } from './schema';

/**
 * Generate a random 16-character hex ID.
 */
export function generateId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Stable SHA-256 hash of a path string, used as a unique key for a workspace.
 */
function hashPath(p: string): string {
  return createHash('sha256').update(p).digest('hex');
}

/**
 * Return the existing workspace for the given project path, or create a new
 * one and return it. Safe to call multiple times — it is idempotent.
 */
export function getOrCreateWorkspace(
  db: Database.Database,
  projectPath: string,
): Workspace {
  const pathHash = hashPath(projectPath);

  const existing = db
    .prepare<[string], Workspace>('SELECT * FROM workspaces WHERE path_hash = ?')
    .get(pathHash);

  if (existing) return existing;

  const id = generateId();
  const name = basename(projectPath);
  const now = Date.now();

  db.prepare(
    'INSERT INTO workspaces (id, name, path_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, name, pathHash, now);

  return { id, name, path_hash: pathHash, created_at: now };
}

/**
 * Return a workspace by ID, or undefined.
 */
export function getWorkspaceById(
  db: Database.Database,
  id: string,
): Workspace | undefined {
  return db
    .prepare<[string], Workspace>('SELECT * FROM workspaces WHERE id = ?')
    .get(id);
}
