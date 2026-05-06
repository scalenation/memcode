import type Database from 'better-sqlite3';
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
  db: Database.Database,
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
  db: Database.Database,
  workspaceId: string,
  status?: DecisionStatus,
  limit = 20,
): Decision[] {
  if (status) {
    return db
      .prepare<[string, string, number]>(
        `SELECT * FROM decisions WHERE workspace_id = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, status, limit) as Decision[];
  }
  return db
    .prepare<[string, number]>(
      `SELECT * FROM decisions WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as Decision[];
}

export function updateDecisionStatus(
  db: Database.Database,
  id: string,
  status: DecisionStatus,
): void {
  db.prepare(
    'UPDATE decisions SET status = ?, updated_at = ? WHERE id = ?',
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
  db: Database.Database,
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
  db: Database.Database,
  workspaceId: string,
  status?: TaskStatus,
  limit = 20,
): Task[] {
  if (status) {
    return db
      .prepare<[string, string, number]>(
        `SELECT * FROM tasks WHERE workspace_id = ? AND status = ?
         ORDER BY
           CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           updated_at DESC LIMIT ?`,
      )
      .all(workspaceId, status, limit) as Task[];
  }
  return db
    .prepare<[string, number]>(
      `SELECT * FROM tasks WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as Task[];
}

export function updateTaskStatus(
  db: Database.Database,
  id: string,
  status: TaskStatus,
): void {
  db.prepare(
    'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
  ).run(status, Date.now(), id);
}
