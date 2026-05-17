/**
 * Agent Run engine — create, advance, pause, rollback, and query runs.
 *
 * A Run is the fundamental orchestration unit: one coding task that proceeds
 * through phases (plan → approve → execute → validate → commit) with a full
 * event/step audit trail and automatic git checkpoint before any changes.
 */
import { execSync, execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './workspace';
import { transaction } from './db';
import type {
  Run,
  RunStep,
  RunEvent,
  RunArtifact,
  RunStatus,
  RunPhase,
  RunPolicy,
} from './schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

function runGit(cmd: string[], cwd: string): string {
  try {
    return execFileSync('git', cmd, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// ── Run CRUD ──────────────────────────────────────────────────────────────────

export interface CreateRunOptions {
  workspaceId: string;
  projectPath: string;
  title: string;
  description?: string;
  policy?: RunPolicy;
}

/**
 * Create a new run record and capture the current git state as the
 * pre-task checkpoint so rollback always has a clean target.
 */
export function createRun(
  db: DatabaseSync,
  opts: CreateRunOptions,
): Run {
  const id = generateId();
  const t = now();
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts.projectPath) || undefined;
  const sha = runGit(['rev-parse', 'HEAD'], opts.projectPath) || undefined;

  const run: Run = {
    id,
    workspace_id: opts.workspaceId,
    title: opts.title,
    description: opts.description,
    status: 'pending',
    policy_json: opts.policy ? JSON.stringify(opts.policy) : undefined,
    git_branch: branch,
    git_sha_before: sha,
    created_at: t,
    updated_at: t,
  };

  db.prepare(`
    INSERT INTO runs
      (id, workspace_id, title, description, status, policy_json,
       git_branch, git_sha_before, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.workspaceId,
    opts.title,
    opts.description ?? null,
    run.policy_json ?? null,
    branch ?? null,
    sha ?? null,
    t,
    t,
  );

  return run;
}

export function getActiveRun(db: DatabaseSync, workspaceId: string): Run | undefined {
  return db.prepare(`
    SELECT * FROM runs
    WHERE workspace_id = ?
      AND status NOT IN ('done','failed','cancelled','rolled-back')
    ORDER BY created_at DESC LIMIT 1
  `).get(workspaceId) as unknown as Run | undefined;
}

export function getRun(db: DatabaseSync, id: string): Run | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as Run | undefined;
}

export function listRuns(db: DatabaseSync, workspaceId: string, limit = 20): Run[] {
  return db.prepare(`
    SELECT * FROM runs WHERE workspace_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(workspaceId, limit) as unknown as Run[];
}

// ── Status Transitions ────────────────────────────────────────────────────────

function setRunStatus(db: DatabaseSync, id: string, status: RunStatus, extra: Partial<Run> = {}): void {
  const t = now();
  const fields: string[] = ['status = ?', 'updated_at = ?'];
  const vals: unknown[] = [status, t];

  if (extra.git_stash_ref !== undefined) { fields.push('git_stash_ref = ?'); vals.push(extra.git_stash_ref); }
  if (extra.git_worktree !== undefined) { fields.push('git_worktree = ?'); vals.push(extra.git_worktree); }
  if (extra.plan_json !== undefined) { fields.push('plan_json = ?'); vals.push(extra.plan_json); }
  if (extra.selected_option !== undefined) { fields.push('selected_option = ?'); vals.push(extra.selected_option); }
  if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'rolled-back') {
    fields.push('finished_at = ?');
    vals.push(t);
  }

  vals.push(id);
  db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...(vals as import('node:sqlite').SQLInputValue[]));
}

export function startRun(db: DatabaseSync, id: string): void {
  setRunStatus(db, id, 'planning');
  addRunEvent(db, id, undefined, 'run.started', { at: now() });
}

export function setPlan(db: DatabaseSync, id: string, plans: unknown[]): void {
  setRunStatus(db, id, 'awaiting-approval', { plan_json: JSON.stringify(plans) });
  addRunEvent(db, id, undefined, 'run.plan-ready', { optionCount: plans.length });
}

export function approveRun(db: DatabaseSync, id: string, option: number): void {
  setRunStatus(db, id, 'executing', { selected_option: option });
  addRunEvent(db, id, undefined, 'run.approved', { option });
}

export function pauseRun(db: DatabaseSync, id: string): void {
  setRunStatus(db, id, 'paused');
  addRunEvent(db, id, undefined, 'run.paused', { at: now() });
}

export function resumeRun(db: DatabaseSync, id: string): void {
  setRunStatus(db, id, 'executing');
  addRunEvent(db, id, undefined, 'run.resumed', { at: now() });
}

export function finishRun(db: DatabaseSync, id: string, success: boolean, notes?: string): void {
  setRunStatus(db, id, success ? 'done' : 'failed');
  addRunEvent(db, id, undefined, success ? 'run.done' : 'run.failed', { notes });
}

export function cancelRun(db: DatabaseSync, id: string, reason?: string): void {
  setRunStatus(db, id, 'cancelled');
  addRunEvent(db, id, undefined, 'run.cancelled', { reason });
}

/**
 * Rollback a run to the pre-task git state.
 *
 * Strategy (in priority order):
 * 1. If a git worktree was used, delete it.
 * 2. If a stash ref exists, pop it.
 * 3. Hard-reset to the captured sha_before.
 */
export function rollbackRun(db: DatabaseSync, id: string, projectPath: string): { message: string } {
  const run = getRun(db, id);
  if (!run) throw new Error(`Run ${id} not found`);

  let message = 'No git state to restore.';

  if (run.git_worktree) {
    runGit(['worktree', 'remove', '--force', run.git_worktree], projectPath);
    message = `Removed git worktree ${run.git_worktree}.`;
  } else if (run.git_stash_ref) {
    const result = runGit(['stash', 'pop', '--index', run.git_stash_ref], projectPath);
    message = result || `Stash pop attempted for ${run.git_stash_ref}.`;
  } else if (run.git_sha_before) {
    runGit(['reset', '--hard', run.git_sha_before], projectPath);
    message = `Hard-reset to ${run.git_sha_before.slice(0, 12)}.`;
  }

  setRunStatus(db, id, 'rolled-back');
  addRunEvent(db, id, undefined, 'run.rolled-back', { message });
  return { message };
}

// ── Steps ─────────────────────────────────────────────────────────────────────

export interface AddStepOptions {
  runId: string;
  phase: RunPhase;
  label: string;
  input?: unknown;
  seq?: number;
}

export function addRunStep(db: DatabaseSync, opts: AddStepOptions): RunStep {
  const id = generateId();
  const t = now();
  const maxSeq = (db.prepare('SELECT MAX(seq) as m FROM run_steps WHERE run_id = ?').get(opts.runId) as { m: number | null }).m ?? -1;
  const seq = opts.seq ?? maxSeq + 1;

  db.prepare(`
    INSERT INTO run_steps (id, run_id, phase, label, status, input_json, seq, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
  `).run(id, opts.runId, opts.phase, opts.label, opts.input ? JSON.stringify(opts.input) : null, seq, t);

  return {
    id, run_id: opts.runId, phase: opts.phase, label: opts.label,
    status: 'running', seq, started_at: t,
    input_json: opts.input ? JSON.stringify(opts.input) : undefined,
  };
}

export function finishRunStep(
  db: DatabaseSync,
  stepId: string,
  success: boolean,
  output?: unknown,
  costUsd?: number,
  model?: string,
): void {
  const t = now();
  db.prepare(`
    UPDATE run_steps
    SET status = ?, output_json = ?, cost_usd = ?, model = ?, finished_at = ?
    WHERE id = ?
  `).run(success ? 'done' : 'failed', output ? JSON.stringify(output) : null, costUsd ?? null, model ?? null, t, stepId);
}

export function listRunSteps(db: DatabaseSync, runId: string): RunStep[] {
  return db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq').all(runId) as unknown as RunStep[];
}

// ── Events ────────────────────────────────────────────────────────────────────

export function addRunEvent(
  db: DatabaseSync,
  runId: string,
  stepId: string | undefined,
  type: string,
  payload?: unknown,
): RunEvent {
  const id = generateId();
  const t = now();
  db.prepare(`
    INSERT INTO run_events (id, run_id, step_id, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, runId, stepId ?? null, type, payload ? JSON.stringify(payload) : null, t);
  return { id, run_id: runId, step_id: stepId, type, payload_json: payload ? JSON.stringify(payload) : undefined, created_at: t };
}

export function listRunEvents(db: DatabaseSync, runId: string, limit = 200): RunEvent[] {
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at LIMIT ?').all(runId, limit) as unknown as RunEvent[];
}

// ── Artifacts ─────────────────────────────────────────────────────────────────

export function addRunArtifact(
  db: DatabaseSync,
  runId: string,
  kind: string,
  content: string,
  opts: { stepId?: string; label?: string; path?: string; metadata?: unknown } = {},
): RunArtifact {
  const id = generateId();
  const t = now();
  db.prepare(`
    INSERT INTO run_artifacts (id, run_id, step_id, kind, label, content, path, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, opts.stepId ?? null, kind, opts.label ?? null, content, opts.path ?? null, opts.metadata ? JSON.stringify(opts.metadata) : null, t);
  return { id, run_id: runId, step_id: opts.stepId, kind, label: opts.label, content, path: opts.path, created_at: t };
}

export function listRunArtifacts(db: DatabaseSync, runId: string): RunArtifact[] {
  return db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at').all(runId) as unknown as RunArtifact[];
}

// ── Plan Builder ──────────────────────────────────────────────────────────────

export interface PlanOption {
  index: number;
  title: string;
  approach: string;
  pros: string[];
  cons: string[];
  riskLevel: 'low' | 'medium' | 'high';
  estimatedFiles: number;
}

/**
 * Build N plan options for a task given a context summary.
 * Returns deterministic rule-based stubs when no LLM is wired.
 */
export function buildPlanOptions(
  task: string,
  contextSummary: string,
  count = 3,
): PlanOption[] {
  const options: PlanOption[] = [
    {
      index: 1,
      title: 'Minimal targeted edit',
      approach: `Implement "${task}" with the smallest possible footprint: edit only the directly affected files and add one test.`,
      pros: ['Low risk', 'Fast execution', 'Easy review'],
      cons: ['May need follow-up refactor', 'Does not address adjacent tech debt'],
      riskLevel: 'low',
      estimatedFiles: 2,
    },
    {
      index: 2,
      title: 'Standard implementation',
      approach: `Implement "${task}" following the detected project conventions. Update affected modules, add/update tests, and adjust documentation.`,
      pros: ['Balanced scope', 'Follows established patterns'],
      cons: ['Moderate review surface'],
      riskLevel: 'medium',
      estimatedFiles: 5,
    },
  ];

  if (count >= 3) {
    options.push({
      index: 3,
      title: 'Structural refactor path',
      approach: `Implement "${task}" with a clean refactor of the underlying structure to improve long-term maintainability.`,
      pros: ['Improves architecture', 'Reduces future debt'],
      cons: ['Higher risk', 'Larger diff', 'Longer review', 'Needs more tests'],
      riskLevel: 'high',
      estimatedFiles: 10,
    });
  }

  // Attach context note so the human can see what was available
  return options.map((o) => ({
    ...o,
    approach: contextSummary
      ? `${o.approach}\n\nContext used: ${contextSummary.slice(0, 300)}`
      : o.approach,
  }));
}

// ── Git Worktree Helper ────────────────────────────────────────────────────────

/**
 * Create an isolated git worktree for a run so changes are fully sandboxed.
 * Returns the worktree path, or undefined on failure.
 */
export function createRunWorktree(projectPath: string, runId: string): string | undefined {
  try {
    const branch = `memcode/run-${runId}`;
    const worktreePath = `${projectPath}/.memory/worktrees/${runId}`;
    runGit(['worktree', 'add', '-b', branch, worktreePath], projectPath);
    return worktreePath;
  } catch {
    return undefined;
  }
}

/**
 * Create a stash before a run for lightweight rollback support.
 * Returns the stash ref string (e.g. "stash@{0}") or undefined if nothing to stash.
 */
export function stashBeforeRun(projectPath: string): string | undefined {
  const stash = runGit(['stash', 'push', '--include-untracked', '-m', 'memcode-run-pre-task'], projectPath);
  if (stash && stash.includes('Saved')) {
    return runGit(['stash', 'list', '--format=%gd', '-1'], projectPath) || undefined;
  }
  return undefined;
}
