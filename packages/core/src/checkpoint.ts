import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './workspace';
import { redact } from './redaction';
import { generateShortSummary, generateLongSummary } from './summarizer';
import { registry } from './providers';
import { transaction } from './db';
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
 * Summary generation:
 *   - Free tier:  deterministic rule-based summaries (synchronous, no network)
 *   - Pro tier:   LLM-powered summaries via the registered SummarizerProvider
 *
 * The write is wrapped in a SQLite transaction so it is atomic.
 * The raw event is also appended to `.memory/events.jsonl`.
 */
export async function createCheckpoint(
  db: DatabaseSync,
  options: CheckpointOptions,
): Promise<Checkpoint> {
  const gitInfo = getGitInfo(options.projectPath);
  const note = options.note ? redact(options.note) : undefined;

  // Use Pro LLM summarizer if registered, otherwise deterministic fallback
  const proSummarizer = registry.getSummarizer();
  const [summaryShort, summaryLong] = proSummarizer
    ? await Promise.all([
        proSummarizer.generateShort(gitInfo, options.trigger, note),
        proSummarizer.generateLong(gitInfo, options.trigger, note),
      ])
    : [
        generateShortSummary(gitInfo, options.trigger, note),
        generateLongSummary(gitInfo, options.trigger, note),
      ];

  const id = generateId();
  const now = Date.now();

  const checkpoint = transaction(db, (): Checkpoint => {
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
  });

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
 * Synchronous variant used by git hooks and VS Code watchers where async is
 * inconvenient. Always uses the deterministic summarizer (Pro LLM summarizer
 * requires await and is not available in sync hooks).
 */
export function createCheckpointSync(
  db: DatabaseSync,
  options: CheckpointOptions,
): Checkpoint {
  const gitInfo = getGitInfo(options.projectPath);
  const note = options.note ? redact(options.note) : undefined;
  const summaryShort = generateShortSummary(gitInfo, options.trigger, note);
  const summaryLong = generateLongSummary(gitInfo, options.trigger, note);

  const id = generateId();
  const now = Date.now();

  const checkpoint = transaction(db, (): Checkpoint => {
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
  });

  try {
    const memoryDir = join(options.projectPath, '.memory');
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    appendFileSync(
      join(memoryDir, 'events.jsonl'),
      JSON.stringify({ type: 'checkpoint', ...checkpoint, git_info: gitInfo }) + '\n',
      'utf-8',
    );
  } catch { /* best effort */ }

  return checkpoint;
}

/**
 * Return all checkpoints for a workspace, newest first.
 */
export function listCheckpoints(
  db: DatabaseSync,
  workspaceId: string,
  limit = 20,
): Checkpoint[] {
  return db
    .prepare(
      `SELECT * FROM checkpoints WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, limit) as unknown as Checkpoint[];
}
