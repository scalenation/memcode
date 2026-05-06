import type Database from 'better-sqlite3';

export interface TimelineEntry {
  id: string;
  type: 'checkpoint' | 'decision' | 'task';
  title: string;
  detail?: string;
  meta?: string;
  created_at: number;
}

/**
 * Return a merged, chronologically sorted list of checkpoints, decisions,
 * and tasks — the project timeline.
 */
export function getTimeline(
  db: Database.Database,
  workspaceId: string,
  limit = 30,
): TimelineEntry[] {
  // Pull independently so each table can contribute up to `limit` rows,
  // then re-sort and slice the merged set.
  const checkpoints = db
    .prepare<[string, number]>(`
      SELECT id, 'checkpoint' AS type,
             summary_short AS title,
             summary_long  AS detail,
             (COALESCE(branch, '') || CASE WHEN git_sha IS NOT NULL THEN ' @' || substr(git_sha,1,8) ELSE '' END) AS meta,
             created_at
      FROM checkpoints WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT ?
    `)
    .all(workspaceId, limit) as TimelineEntry[];

  const decisions = db
    .prepare<[string, number]>(`
      SELECT id, 'decision' AS type,
             title,
             rationale AS detail,
             status    AS meta,
             created_at
      FROM decisions WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT ?
    `)
    .all(workspaceId, limit) as TimelineEntry[];

  const tasks = db
    .prepare<[string, number]>(`
      SELECT id, 'task' AS type,
             title,
             description AS detail,
             (status || COALESCE(' [' || priority || ']', '')) AS meta,
             created_at
      FROM tasks WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT ?
    `)
    .all(workspaceId, limit) as TimelineEntry[];

  return [...checkpoints, ...decisions, ...tasks]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}
