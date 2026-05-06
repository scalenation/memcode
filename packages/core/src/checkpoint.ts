import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { generateId } from './workspace';
import { redact } from './redaction';
import { generateShortSummary, generateLongSummary } from './summarizer';
import type { Checkpoint } from './schema';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export interface GitInfo {
  sha?: string;
  branch?: string;
  commitMessage?: string;
  filesChanged?: string[];
  statsSummary?: string;
}

/**
 * Collect git metadata from the given working directory.
 * Never throws — returns partial info on any git failure.
 */
export function getGitInfo(cwd: string): GitInfo {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
        .toString()
        .trim();
    } catch {
      return '';
    }
  };

  const sha = run('git rev-parse HEAD') || undefined;
  const branch = run('git rev-parse --abbrev-ref HEAD') || undefined;
  const commitMessage = run('git log -1 --pretty=%B') || undefined;
  const statusOutput = run('git status --short');
  const filesChanged = statusOutput
    ? statusOutput.split('\n').filter(Boolean)
    : [];
  const statsSummary =
    run('git diff --stat HEAD~1 HEAD') || undefined;

  return { sha, branch, commitMessage, filesChanged, statsSummary };
}

// ---------------------------------------------------------------------------
// Checkpoint options
// ---------------------------------------------------------------------------

export interface CheckpointOptions {
  /** Workspace ID (from `getOrCreateWorkspace`). */
  workspaceId: string;
  /** Absolute path to the project root (contains `.memory/`). */
  projectPath: string;
  /** What triggered this checkpoint: 'manual' | 'pre-commit' | 'post-commit' | 'branch-switch' | 'on-save' */
  trigger: string;
  /** Optional free-text note (will be redacted before persistence). */
  note?: string;
  /** Optional session ID to link this checkpoint to an active session. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint creation
// ---------------------------------------------------------------------------

/**
 * Create and persist a checkpoint.
 *
 * The write is wrapped in a SQLite transaction so it is atomic.
 * The raw event is also appended to `.memory/events.jsonl`.
 */
export function createCheckpoint(
  db: Database.Database,
  options: CheckpointOptions,
): Checkpoint {
  const gitInfo = getGitInfo(options.projectPath);
  const note = options.note ? redact(options.note) : undefined;

  const summaryShort = generateShortSummary(gitInfo, options.trigger, note);
  const summaryLong = generateLongSummary(gitInfo, options.trigger, note);

  const id = generateId();
  const now = Date.now();

  const checkpoint = db.transaction((): Checkpoint => {
    db.prepare(`
      INSERT INTO checkpoints
        (id, workspace_id, session_id, git_sha, branch, trigger, summary_short, summary_long, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      options.workspaceId,
      options.sessionId ?? null,
      gitInfo.sha ?? null,
      gitInfo.branch ?? null,
      options.trigger,
      summaryShort,
      summaryLong,
      now,
    );

    return {
      id,
      workspace_id: options.workspaceId,
      session_id: options.sessionId,
      git_sha: gitInfo.sha,
      branch: gitInfo.branch,
      trigger: options.trigger,
      summary_short: summaryShort,
      summary_long: summaryLong,
      created_at: now,
    };
  })();

  // Append raw event to the JSONL archive (best-effort)
  try {
    const memoryDir = join(options.projectPath, '.memory');
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    const event = {
      type: 'checkpoint',
      ...checkpoint,
      git_info: gitInfo,
    };
    appendFileSync(
      join(memoryDir, 'events.jsonl'),
      JSON.stringify(event) + '\n',
      'utf-8',
    );
  } catch {
    // JSONL append failure must not break the main write
  }

  return checkpoint;
}

/**
 * Return all checkpoints for a workspace, newest first.
 */
export function listCheckpoints(
  db: Database.Database,
  workspaceId: string,
  limit = 20,
): Checkpoint[] {
  return db
    .prepare<[string, number], Checkpoint>(
      `SELECT * FROM checkpoints WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as Checkpoint[];
}
