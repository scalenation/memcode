/**
 * Snapshot — the "Handoff Artifact" (Feature A from spec).
 *
 * Generates two files inside .memory/:
 *   snapshot.json         — machine-readable state for the MCP server
 *   CONTEXT_SNAPSHOT.md   — agent-readable markdown for direct injection
 *
 * Called automatically by the watch daemon on inactivity and by `memory checkpoint`.
 * Any agent starting a new session reads this in < 1 tool call to resume instantly.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { Workspace, Task, Decision, Assumption, Run } from './schema';
import { listAssumptions } from './assumptions';
import { listRuns } from './run';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectSnapshot {
  generated_at: string;
  workspace: {
    name: string;
    branch?: string;
    commit?: string;
    commit_message?: string;
  };
  goal?: string;
  progress?: string;
  blocker?: string;
  active_tasks: Array<{ id: string; title: string; status: string; priority?: string }>;
  recent_decisions: Array<{ title: string; rationale: string }>;
  modified_files: string[];
  recent_checkpoint?: { note: string; branch?: string; commit?: string; at: string };
  active_run?: { id: string; title: string; status: string; stash_ref?: string };
  assumptions: Array<{ key: string; value: string }>;
}

// ── Git helpers ────────────────────────────────────────────────────────────────

function gitBranch(projectPath: string): string | undefined {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return undefined; }
}

function gitShort(projectPath: string): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return undefined; }
}

function gitCommitMessage(projectPath: string): string | undefined {
  try {
    return execSync('git log -1 --pretty=%s', { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return undefined; }
}

function gitModifiedFiles(projectPath: string): string[] {
  try {
    return execSync('git status --porcelain', { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .filter(l => l.trim())
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch { return []; }
}

// ── Core snapshot builder ──────────────────────────────────────────────────────

export function buildSnapshot(
  db: DatabaseSync,
  workspaceId: string,
  projectPath: string,
): ProjectSnapshot {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(workspaceId) as unknown as Workspace;

  const activeTasks = db.prepare(
    `SELECT id, title, status, priority FROM tasks
     WHERE workspace_id = ? AND status IN ('open','in-progress')
     ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC
     LIMIT 8`,
  ).all(workspaceId) as unknown as Task[];

  const recentDecisions = db.prepare(
    `SELECT title, rationale FROM decisions
     WHERE workspace_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 4`,
  ).all(workspaceId) as unknown as Decision[];

  const latestCheckpoint = db.prepare(
    `SELECT summary_short, branch, git_sha, created_at FROM checkpoints
     WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(workspaceId) as unknown as { summary_short: string; branch?: string; git_sha?: string; created_at: number } | undefined;

  const assumptions = listAssumptions(db, workspaceId);
  const runs = listRuns(db, workspaceId);
  const activeRun = runs.find(r => ['executing', 'planning', 'awaiting-approval', 'paused'].includes(r.status));

  // Goal: active run title, or highest-priority in-progress task
  const primaryTask = activeTasks.find(t => t.status === 'in-progress') ?? activeTasks[0];
  const goal = activeRun?.title ?? primaryTask?.title;

  // Progress: latest checkpoint note
  const progress = latestCheckpoint
    ? `${latestCheckpoint.summary_short}${latestCheckpoint.branch ? ` (${latestCheckpoint.branch})` : ''}`
    : undefined;

  const modified = gitModifiedFiles(projectPath);
  const branch = gitBranch(projectPath);
  const commit = gitShort(projectPath);

  return {
    generated_at: new Date().toISOString(),
    workspace: {
      name: workspace?.name ?? 'unknown',
      branch,
      commit,
      commit_message: gitCommitMessage(projectPath),
    },
    goal,
    progress,
    blocker: undefined, // agents can set this via MCP record_progress
    active_tasks: activeTasks.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })),
    recent_decisions: recentDecisions.map(d => ({ title: d.title, rationale: d.rationale })),
    modified_files: modified,
    recent_checkpoint: latestCheckpoint ? {
      note: latestCheckpoint.summary_short,
      branch: latestCheckpoint.branch,
      commit: latestCheckpoint.git_sha?.slice(0, 8),
      at: new Date(latestCheckpoint.created_at).toISOString(),
    } : undefined,
    active_run: activeRun ? {
      id: activeRun.id,
      title: activeRun.title,
      status: activeRun.status,
      stash_ref: activeRun.git_stash_ref,
    } : undefined,
    assumptions: assumptions.slice(0, 10).map(a => ({ key: a.key, value: a.value })),
  };
}

// ── Markdown renderer ──────────────────────────────────────────────────────────

export function renderSnapshotMarkdown(snap: ProjectSnapshot): string {
  const lines: string[] = [
    `# Context Snapshot — ${snap.workspace.name}`,
    `> Generated ${snap.generated_at.slice(0, 16).replace('T', ' ')} UTC` +
      (snap.workspace.branch ? ` | Branch: \`${snap.workspace.branch}\`` : '') +
      (snap.workspace.commit ? ` | Commit: \`${snap.workspace.commit}\`` : ''),
    '',
  ];

  lines.push('## Goal');
  lines.push(snap.goal ? snap.goal : '_No active task or run._');
  lines.push('');

  lines.push('## Progress');
  if (snap.progress) lines.push(`Last checkpoint: ${snap.progress}`);
  if (snap.modified_files.length > 0) {
    lines.push(`Modified files (${snap.modified_files.length}):`);
    for (const f of snap.modified_files.slice(0, 10)) {
      lines.push(`  - \`${f}\``);
    }
  } else {
    lines.push('No uncommitted changes.');
  }
  lines.push('');

  lines.push('## Blockers');
  lines.push(snap.blocker ?? 'No blockers detected.');
  lines.push('');

  if (snap.active_tasks.length > 0) {
    lines.push('## Active Tasks');
    for (const t of snap.active_tasks) {
      const p = t.priority ? ` \`[${t.priority}]\`` : '';
      lines.push(`- [${t.status}]${p} ${t.title}`);
    }
    lines.push('');
  }

  if (snap.assumptions.length > 0) {
    lines.push('## Project Rules');
    for (const a of snap.assumptions) {
      lines.push(`- **${a.key}**: ${a.value}`);
    }
    lines.push('');
  }

  if (snap.recent_decisions.length > 0) {
    lines.push('## Key Decisions');
    for (const d of snap.recent_decisions) {
      lines.push(`- **${d.title}**: ${d.rationale}`);
    }
    lines.push('');
  }

  if (snap.active_run) {
    lines.push('## Active Agent Run');
    lines.push(`- **${snap.active_run.title}** — status: \`${snap.active_run.status}\``);
    if (snap.active_run.stash_ref) lines.push(`  - Rollback ref: \`${snap.active_run.stash_ref}\``);
    lines.push('');
  }

  return lines.join('\n');
}

// ── File writers ───────────────────────────────────────────────────────────────

export function writeSnapshot(
  db: DatabaseSync,
  workspaceId: string,
  projectPath: string,
  memoryDir: string,
): ProjectSnapshot {
  const snap = buildSnapshot(db, workspaceId, projectPath);

  // Machine-readable JSON
  writeFileSync(join(memoryDir, 'snapshot.json'), JSON.stringify(snap, null, 2), 'utf-8');

  // Agent-readable Markdown
  writeFileSync(join(memoryDir, 'CONTEXT_SNAPSHOT.md'), renderSnapshotMarkdown(snap), 'utf-8');

  return snap;
}

/** Read the last snapshot from disk (for MCP server, no DB needed). */
export function readSnapshot(memoryDir: string): ProjectSnapshot | null {
  const p = join(memoryDir, 'snapshot.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ProjectSnapshot;
  } catch { return null; }
}
