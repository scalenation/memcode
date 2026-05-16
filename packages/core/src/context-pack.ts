import type { DatabaseSync } from 'node:sqlite';
import type { Workspace, Checkpoint, Task, Decision, Session, Message } from './schema';

type SessionDigest = Session & {
  messageCount: number;
  lastMessageAt: number;
  firstUserPrompt: string | null;
  lastAssistantReply: string | null;
};

/**
 * Compose a compact, prompt-ready context block for the current workspace.
 *
 * Targets < 500 ms on typical repos (single SQLite read, no file I/O).
 * Keeps output under ~2000 tokens by design.
 */
export function generateContextPack(
  db: DatabaseSync,
  workspaceId: string,
): string {
  const workspace = db
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(workspaceId) as unknown as Workspace | undefined;

  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' not found in database.`);
  }

  const latestCheckpoint = db
    .prepare(
      `SELECT * FROM checkpoints WHERE workspace_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspaceId) as unknown as Checkpoint | undefined;

  const activeTasks = db
    .prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND status IN ('open', 'in-progress')
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT 7
    `)
    .all(workspaceId) as unknown as Task[];

  const recentDecisions = db
    .prepare(`
      SELECT * FROM decisions
      WHERE workspace_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 5
    `)
    .all(workspaceId) as unknown as Decision[];

  const recentCheckpoints = db
    .prepare(`
      SELECT * FROM checkpoints WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT 4
    `)
    .all(workspaceId) as unknown as Checkpoint[];

  const recentSessions = db
    .prepare(
      `SELECT s.*, COUNT(m.id) AS message_count, MAX(m.created_at) AS last_message_at
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.workspace_id = ?
       GROUP BY s.id
       ORDER BY COALESCE(MAX(m.created_at), s.ended_at, s.started_at) DESC
       LIMIT 3`,
    )
    .all(workspaceId) as Array<Session & { message_count: number | null; last_message_at: number | null }>;

  const sessionDigests: SessionDigest[] = recentSessions.map((session) => ({
    ...session,
    messageCount: Number(session.message_count ?? 0),
    lastMessageAt: Number(session.last_message_at ?? session.ended_at ?? session.started_at),
    firstUserPrompt: summarizeMessage(
      db.prepare(
        `SELECT content
         FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY created_at ASC
         LIMIT 1`,
      ).get(session.id) as Message | undefined,
    ),
    lastAssistantReply: summarizeMessage(
      db.prepare(
        `SELECT content
         FROM messages
         WHERE session_id = ? AND role = 'assistant'
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(session.id) as Message | undefined,
    ),
  }));

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

  // ── Recent AI sessions ──────────────────────────────────────────────────
  if (sessionDigests.length > 0) {
    lines.push('## Recent AI Sessions');
    lines.push('_Use these as progressive-disclosure breadcrumbs before re-explaining the project._');
    for (const session of sessionDigests) {
      const sessionDate = new Date(session.lastMessageAt).toLocaleDateString();
      const source = [session.agent, session.editor].filter(Boolean).join(' · ') || 'AI chat';
      const messageLabel = `${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`;
      lines.push(`- **${sessionDate}** — ${source} (${messageLabel})`);
      if (session.firstUserPrompt) {
        lines.push(`  - User intent: ${session.firstUserPrompt}`);
      }
      if (session.lastAssistantReply) {
        lines.push(`  - Assistant outcome: ${session.lastAssistantReply}`);
      }
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

function summarizeMessage(message?: Message): string | null {
  if (!message?.content) return null;
  return truncateInline(message.content, 160);
}

function truncateInline(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}
