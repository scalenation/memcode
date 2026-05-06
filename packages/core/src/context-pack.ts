import type Database from 'better-sqlite3';
import type { Workspace, Checkpoint, Task, Decision } from './schema';

/**
 * Compose a compact, prompt-ready context block for the current workspace.
 *
 * Targets < 500 ms on typical repos (single SQLite read, no file I/O).
 * Keeps output under ~2000 tokens by design.
 */
export function generateContextPack(
  db: Database.Database,
  workspaceId: string,
): string {
  const workspace = db
    .prepare<[string], Workspace>('SELECT * FROM workspaces WHERE id = ?')
    .get(workspaceId);

  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' not found in database.`);
  }

  const latestCheckpoint = db
    .prepare<[string], Checkpoint>(
      `SELECT * FROM checkpoints WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspaceId);

  const activeTasks = db
    .prepare<[string], Task>(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND status IN ('open', 'in-progress')
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT 7
    `)
    .all(workspaceId) as Task[];

  const recentDecisions = db
    .prepare<[string], Decision>(`
      SELECT * FROM decisions
      WHERE workspace_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 5
    `)
    .all(workspaceId) as Decision[];

  const recentCheckpoints = db
    .prepare<[string], Checkpoint>(`
      SELECT * FROM checkpoints WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT 4
    `)
    .all(workspaceId) as Checkpoint[];

  const lines: string[] = [
    `# Project Memory Context — ${workspace.name}`,
    `> Generated ${new Date().toISOString()}`,
    '',
  ];

  // ── Current state ──────────────────────────────────────────────────────
  if (latestCheckpoint) {
    lines.push('## Current State');
    lines.push(`- **Branch**: \`${latestCheckpoint.branch ?? 'unknown'}\``);
    if (latestCheckpoint.git_sha) {
      lines.push(`- **Commit**: \`${latestCheckpoint.git_sha.slice(0, 12)}\``);
    }
    lines.push(`- **Last checkpoint**: ${latestCheckpoint.summary_short}`);
    lines.push('');
  }

  // ── Active tasks ───────────────────────────────────────────────────────
  if (activeTasks.length > 0) {
    lines.push('## Active Tasks');
    for (const task of activeTasks) {
      const prio = task.priority ? ` \`[${task.priority}]\`` : '';
      lines.push(`- **[${task.status}]**${prio} ${task.title}`);
      if (task.description) {
        lines.push(`  > ${task.description.slice(0, 120)}`);
      }
    }
    lines.push('');
  }

  // ── Key decisions ──────────────────────────────────────────────────────
  if (recentDecisions.length > 0) {
    lines.push('## Key Decisions');
    for (const d of recentDecisions) {
      lines.push(`- **${d.title}**: ${d.rationale.slice(0, 180)}`);
      if (d.impact) lines.push(`  *Impact*: ${d.impact.slice(0, 100)}`);
    }
    lines.push('');
  }

  // ── Recent activity ────────────────────────────────────────────────────
  if (recentCheckpoints.length > 1) {
    lines.push('## Recent Activity');
    for (const cp of recentCheckpoints) {
      const date = new Date(cp.created_at).toLocaleDateString();
      lines.push(`- ${date} \`[${cp.trigger}]\` ${cp.summary_short}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
