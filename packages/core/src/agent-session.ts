/**
 * Agent sessions — tracks live coding agent working sessions.
 *
 * Distinct from the existing `sessions` table (which stores AI chat imports).
 * An AgentSession represents "a developer working with an agent tool":
 *   - Starts when `memory mcp` is connected or `memory session start` is run
 *   - Heartbeat every N seconds from the watch daemon
 *   - Ends on disconnect or explicit `memory session end`
 *   - Stores a rollback stash ref so one-click rollback is possible
 */

import type { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { generateId } from './workspace';
import type { AgentSession } from './schema';

export type { AgentSession };

export interface StartSessionOptions {
  workspaceId: string;
  projectPath: string;
  agent?: string;     // 'cursor' | 'claude' | 'copilot' | 'windsurf' | 'custom'
  goal?: string;
  runId?: string;
  createStash?: boolean;
}

function gitStash(projectPath: string, message: string): string | undefined {
  try {
    execSync(`git stash push --include-untracked -m "${message}"`, {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Get the new stash ref
    const refs = execSync('git stash list --format=%gd -1', {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return refs || undefined;
  } catch { return undefined; }
}

export function startAgentSession(db: DatabaseSync, opts: StartSessionOptions): AgentSession {
  const id = generateId();
  const t = Date.now();

  let stashRef: string | undefined;
  if (opts.createStash) {
    stashRef = gitStash(opts.projectPath, `memcode-session-${id.slice(0, 8)}`);
  }

  db.prepare(`
    INSERT INTO agent_sessions
      (id, workspace_id, run_id, agent, status, goal, stash_ref, started_at, last_heartbeat_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, opts.workspaceId, opts.runId ?? null, opts.agent ?? 'unknown', opts.goal ?? null, stashRef ?? null, t, t);

  return { id, workspace_id: opts.workspaceId, run_id: opts.runId, agent: opts.agent ?? 'unknown', status: 'active', goal: opts.goal, stash_ref: stashRef, started_at: t, last_heartbeat_at: t };
}

export function heartbeatSession(db: DatabaseSync, sessionId: string): void {
  db.prepare('UPDATE agent_sessions SET last_heartbeat_at = ?, status = ? WHERE id = ?')
    .run(Date.now(), 'active', sessionId);
}

export function updateSessionGoal(db: DatabaseSync, sessionId: string, goal: string, blocker?: string, filesChanged?: string[]): void {
  db.prepare('UPDATE agent_sessions SET goal = ?, files_changed = ?, blocker = ?, last_heartbeat_at = ? WHERE id = ?')
    .run(goal, filesChanged ? JSON.stringify(filesChanged) : null, blocker ?? null, Date.now(), sessionId);
}

export function endAgentSession(db: DatabaseSync, sessionId: string, snapshotJson?: string): void {
  db.prepare('UPDATE agent_sessions SET status = ?, ended_at = ?, snapshot_json = ? WHERE id = ?')
    .run('ended', Date.now(), snapshotJson ?? null, sessionId);
}

export function getActiveSession(db: DatabaseSync, workspaceId: string): AgentSession | undefined {
  return db.prepare(
    `SELECT * FROM agent_sessions WHERE workspace_id = ? AND status IN ('active','idle')
     ORDER BY last_heartbeat_at DESC LIMIT 1`,
  ).get(workspaceId) as unknown as AgentSession | undefined;
}

export function listAgentSessions(db: DatabaseSync, workspaceId: string, limit = 20): AgentSession[] {
  return db.prepare(
    'SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?',
  ).all(workspaceId, limit) as unknown as AgentSession[];
}

export function getAgentSession(db: DatabaseSync, id: string): AgentSession | undefined {
  return db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as unknown as AgentSession | undefined;
}

/** Mark sessions with no heartbeat in >5 min as idle, >30 min as ended. */
export function reapStaleSessions(db: DatabaseSync, workspaceId: string): void {
  const now = Date.now();
  db.prepare(`UPDATE agent_sessions SET status = 'idle' WHERE workspace_id = ? AND status = 'active' AND last_heartbeat_at < ?`)
    .run(workspaceId, now - 5 * 60 * 1000);
  db.prepare(`UPDATE agent_sessions SET status = 'ended', ended_at = ? WHERE workspace_id = ? AND status = 'idle' AND last_heartbeat_at < ?`)
    .run(now, workspaceId, now - 30 * 60 * 1000);
}

/** Rollback to session stash — runs `git stash pop stash@{n}`. */
export function rollbackSession(db: DatabaseSync, sessionId: string, projectPath: string): { ok: boolean; message: string } {
  const session = getAgentSession(db, sessionId);
  if (!session) return { ok: false, message: 'Session not found' };
  if (!session.stash_ref) return { ok: false, message: 'No stash ref recorded for this session' };

  try {
    // Discard any current changes first (they're in the session snapshot)
    execSync('git checkout -- .', { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] });
    execSync(`git stash pop ${session.stash_ref}`, { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] });
    endAgentSession(db, sessionId);
    return { ok: true, message: `Rolled back to ${session.stash_ref}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
