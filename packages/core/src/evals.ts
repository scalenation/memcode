/**
 * Eval engine — benchmark tasks and result tracking for agent/model regression testing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './workspace';
import type { EvalTask, EvalResult } from './schema';

export interface CreateEvalTaskOptions {
  workspaceId: string;
  title: string;
  description?: string;
  acceptance?: unknown;
}

export function createEvalTask(db: DatabaseSync, opts: CreateEvalTaskOptions): EvalTask {
  const id = generateId();
  const t = Date.now();
  db.prepare(`
    INSERT INTO eval_tasks (id, workspace_id, title, description, acceptance_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(id, opts.workspaceId, opts.title, opts.description ?? null, opts.acceptance ? JSON.stringify(opts.acceptance) : null, t);
  return { id, workspace_id: opts.workspaceId, title: opts.title, description: opts.description, status: 'active', created_at: t };
}

export function listEvalTasks(db: DatabaseSync, workspaceId: string): EvalTask[] {
  return db.prepare(
    "SELECT * FROM eval_tasks WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC",
  ).all(workspaceId) as unknown as EvalTask[];
}

export function archiveEvalTask(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE eval_tasks SET status = 'archived' WHERE id = ?").run(id);
}

export interface RecordEvalResultOptions {
  evalTaskId: string;
  runId?: string;
  agent?: string;
  model?: string;
  passed: boolean;
  score?: number;
  notes?: string;
}

export function recordEvalResult(db: DatabaseSync, opts: RecordEvalResultOptions): EvalResult {
  const id = generateId();
  const t = Date.now();
  db.prepare(`
    INSERT INTO eval_results
      (id, eval_task_id, run_id, agent, model, passed, score, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.evalTaskId, opts.runId ?? null, opts.agent ?? null, opts.model ?? null, opts.passed ? 1 : 0, opts.score ?? null, opts.notes ?? null, t);
  return {
    id, eval_task_id: opts.evalTaskId, run_id: opts.runId, agent: opts.agent,
    model: opts.model, passed: opts.passed ? 1 : 0, score: opts.score, notes: opts.notes, created_at: t,
  };
}

export function listEvalResults(db: DatabaseSync, evalTaskId: string): EvalResult[] {
  return db.prepare(
    'SELECT * FROM eval_results WHERE eval_task_id = ? ORDER BY created_at DESC',
  ).all(evalTaskId) as unknown as EvalResult[];
}

export function evalSummary(db: DatabaseSync, workspaceId: string): { task: EvalTask; passRate: number; runs: number }[] {
  const tasks = listEvalTasks(db, workspaceId);
  return tasks.map((task) => {
    const results = listEvalResults(db, task.id);
    const passed = results.filter((r) => r.passed).length;
    return { task, passRate: results.length > 0 ? passed / results.length : 0, runs: results.length };
  });
}
