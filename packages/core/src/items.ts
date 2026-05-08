import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './workspace';
import type { Decision, Task, DecisionStatus, TaskStatus, TaskPriority } from './schema';

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface CreateDecisionOptions {
  workspaceId: string;
  title: string;
  rationale: string;
  impact?: string;
  checkpointId?: string;
}

export function createDecision(
  db: DatabaseSync,
  opts: CreateDecisionOptions,
): Decision {
  const id = generateId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO decisions
      (id, workspace_id, title, rationale, impact, status, checkpoint_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id,
    opts.workspaceId,
    opts.title,
    opts.rationale,
    opts.impact ?? null,
    opts.checkpointId ?? null,
    now,
    now,
  );

  return {
    id,
    workspace_id: opts.workspaceId,
    title: opts.title,
    rationale: opts.rationale,
    impact: opts.impact,
    status: 'active',
    checkpoint_id: opts.checkpointId,
    created_at: now,
    updated_at: now,
  };
}

export function listDecisions(
  db: DatabaseSync,
  workspaceId: string,
  status?: DecisionStatus | 'all',
  limit = 20,
): Decision[] {
  if (status && status !== 'all') {
    return db
      .prepare(
        `SELECT * FROM decisions WHERE workspace_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, status, limit) as unknown as Decision[];
  }
  return db
    .prepare(
      `SELECT * FROM decisions WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as unknown as Decision[];
}

export function updateDecisionStatus(
  db: DatabaseSync,
  id: string,
  status: DecisionStatus,
): void {
  db.prepare(
    "UPDATE decisions SET status = ?, updated_at = ? WHERE id LIKE ? || '%'",
  ).run(status, Date.now(), id);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface CreateTaskOptions {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  decisionId?: string;
  checkpointId?: string;
}

export function createTask(
  db: DatabaseSync,
  opts: CreateTaskOptions,
): Task {
  const id = generateId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO tasks
      (id, workspace_id, title, description, status, priority, decision_id, checkpoint_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.workspaceId,
    opts.title,
    opts.description ?? null,
    opts.priority ?? null,
    opts.decisionId ?? null,
    opts.checkpointId ?? null,
    now,
    now,
  );

  return {
    id,
    workspace_id: opts.workspaceId,
    title: opts.title,
    description: opts.description,
    status: 'open',
    priority: opts.priority,
    decision_id: opts.decisionId,
    checkpoint_id: opts.checkpointId,
    created_at: now,
    updated_at: now,
  };
}

export function listTasks(
  db: DatabaseSync,
  workspaceId: string,
  status?: TaskStatus | 'all',
  limit = 20,
): Task[] {
  if (status && status !== 'all') {
    return db
      .prepare(
        `SELECT * FROM tasks WHERE workspace_id = ? AND status = ?
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           updated_at DESC LIMIT ?`,
      )
      .all(workspaceId, status, limit) as unknown as Task[];
  }
  return db
    .prepare(
      `SELECT * FROM tasks WHERE workspace_id = ?
       ORDER BY
         CASE status WHEN 'open' THEN 1 WHEN 'in-progress' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
         CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         updated_at DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as unknown as Task[];
}

export function updateTaskStatus(
  db: DatabaseSync,
  id: string,
  status: TaskStatus,
): void {
  db.prepare(
    "UPDATE tasks SET status = ?, updated_at = ? WHERE id LIKE ? || '%'",
  ).run(status, Date.now(), id);
}
