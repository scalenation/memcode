/**
 * Assumptions registry — the active knowledge layer for coding agents.
 *
 * The agent records what it "knows" about the codebase here (e.g. "We use
 * native CSS, not Tailwind"). Developers can view, edit, invalidate, or
 * remove entries so the agent never repeats a false assumption.
 */
import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './workspace';
import type { Assumption, AssumptionSource } from './schema';

export interface SetAssumptionOptions {
  workspaceId: string;
  key: string;
  value: string;
  source?: AssumptionSource;
  runId?: string;
}

/**
 * Upsert an assumption. If the key already exists it updates the value and
 * marks it fresh; otherwise creates a new entry.
 */
export function setAssumption(db: DatabaseSync, opts: SetAssumptionOptions): Assumption {
  const existing = db.prepare(
    'SELECT * FROM assumptions WHERE workspace_id = ? AND key = ?',
  ).get(opts.workspaceId, opts.key) as unknown as Assumption | undefined;

  const t = Date.now();

  if (existing) {
    db.prepare(`
      UPDATE assumptions
      SET value = ?, source = ?, stale = 0, run_id = ?, updated_at = ?
      WHERE workspace_id = ? AND key = ?
    `).run(opts.value, opts.source ?? existing.source, opts.runId ?? null, t, opts.workspaceId, opts.key);
    return { ...existing, value: opts.value, stale: 0, updated_at: t };
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO assumptions
      (id, workspace_id, key, value, source, stale, run_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, opts.workspaceId, opts.key, opts.value, opts.source ?? 'agent', opts.runId ?? null, t, t);

  return {
    id,
    workspace_id: opts.workspaceId,
    key: opts.key,
    value: opts.value,
    source: opts.source ?? 'agent',
    stale: 0,
    run_id: opts.runId,
    created_at: t,
    updated_at: t,
  };
}

export function listAssumptions(
  db: DatabaseSync,
  workspaceId: string,
  includeStale = false,
): Assumption[] {
  if (includeStale) {
    return db.prepare(
      'SELECT * FROM assumptions WHERE workspace_id = ? ORDER BY updated_at DESC',
    ).all(workspaceId) as unknown as Assumption[];
  }
  return db.prepare(
    'SELECT * FROM assumptions WHERE workspace_id = ? AND stale = 0 ORDER BY updated_at DESC',
  ).all(workspaceId) as unknown as Assumption[];
}

export function getAssumption(db: DatabaseSync, id: string): Assumption | undefined {
  return db.prepare('SELECT * FROM assumptions WHERE id = ?').get(id) as unknown as Assumption | undefined;
}

export function invalidateAssumption(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE assumptions SET stale = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function removeAssumption(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM assumptions WHERE id = ?').run(id);
}

export function clearAssumptions(db: DatabaseSync, workspaceId: string): void {
  db.prepare('DELETE FROM assumptions WHERE workspace_id = ?').run(workspaceId);
}

/**
 * Build a compact assumptions block suitable for injecting into agent context.
 */
export function formatAssumptionsForContext(assumptions: Assumption[]): string {
  if (assumptions.length === 0) return '';
  const lines = assumptions.map((a) => `- [${a.source}] ${a.key}: ${a.value}`);
  return `## Active Codebase Assumptions\n${lines.join('\n')}`;
}
