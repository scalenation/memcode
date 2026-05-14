import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint, Decision, Message, Session, Task, SyncState } from '@memcode/core';
import { transaction } from '@memcode/core';
import { encryptPayload, decryptPayload } from './client';
import type { CloudConfig, SyncPayload } from './client';

export interface PushResult {
  cursor: string;
  uploadedAt: number;
  sessionsCount: number;
  messagesCount: number;
  checkpointsCount: number;
  decisionsCount: number;
  tasksCount: number;
}

export interface PullResult {
  cursor: string;
  skippedBlobs?: number;
  merged: {
    sessions: number;
    messages: number;
    checkpoints: number;
    decisions: number;
    tasks: number;
  };
}

/**
 * Push workspace summaries and metadata to the cloud API.
 *
 * All data is encrypted client-side before transmission. Structured metadata is
 * uploaded alongside the encrypted blob so the dashboard can render history.
 *
 * NOTE: This is a stub implementation. Wire up `config.endpoint` to the
 * live API gateway when the cloud backend is available.
 */
export async function pushSync(
  db: DatabaseSync,
  config: CloudConfig,
): Promise<PushResult> {
  assertEnabled(config);

  // Ensure the workspace is registered on the server before pushing
  await fetch(`${config.endpoint}/v1/sync/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ workspaceId: config.workspaceId }),
  });

  // Pull and merge the latest cloud snapshot first. This keeps two machines
  // from overwriting each other's newest memory when either one pushes.
  await pullSync(db, config);

  // Collect the complete merged workspace snapshot. The latest cloud blob is
  // intentionally self-contained so any machine can restore from it directly.
  const sessions = db
    .prepare(
      'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at',
    )
    .all(config.workspaceId) as unknown as Session[];

  const messages = db
    .prepare(
      `SELECT m.*
       FROM messages m
       INNER JOIN sessions s ON s.id = m.session_id
       WHERE s.workspace_id = ?
       ORDER BY m.created_at`,
    )
    .all(config.workspaceId) as unknown as Message[];

  const checkpoints = db
    .prepare(
      'SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at',
    )
    .all(config.workspaceId) as unknown as Checkpoint[];

  const decisions = db
    .prepare(
      'SELECT * FROM decisions WHERE workspace_id = ? ORDER BY created_at',
    )
    .all(config.workspaceId) as unknown as Decision[];

  const tasks = db
    .prepare(
      'SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at',
    )
    .all(config.workspaceId) as unknown as Task[];

  const now = Date.now();
  const cursor = String(now);

  const payload: SyncPayload = {
    workspaceId: config.workspaceId,
    sessions,
    messages,
    checkpoints,
    decisions,
    tasks,
    cursor,
    encryptedAt: now,
  };

  const encrypted = encryptPayload(payload, config.encryptionKey);

  // Build dashboard metadata. The encrypted blob remains the source of truth;
  // this metadata powers searchable history in the web dashboard.
  const meta = [
    ...checkpoints.map(cp => ({
      type: 'checkpoint',
      id: cp.id,
      trigger: cp.trigger,
      branch: cp.branch ?? null,
      git_sha: cp.git_sha ? cp.git_sha.slice(0, 12) : null,
      summary: cp.summary_short,
      created_at: cp.created_at,
    })),
    ...messages.map(message => ({
      type: 'chat',
      id: message.id,
      role: message.role,
      summary: message.content,
      created_at: message.created_at,
    })),
  ].sort((a, b) => b.created_at - a.created_at);

  // HTTP POST to cloud API
  const response = await fetch(`${config.endpoint}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ workspaceId: config.workspaceId, payload: encrypted, meta }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud sync push failed: ${response.status} ${body}`);
  }

  const { cursor: serverCursor } = (await response.json()) as { cursor: string };

  // Update local sync state
  upsertSyncState(db, config.workspaceId, {
    enabled: 1,
    last_cursor: serverCursor,
    last_synced_at: now,
    provider: 'memcode',
  });

  return {
    cursor: serverCursor,
    uploadedAt: now,
    sessionsCount: sessions.length,
    messagesCount: messages.length,
    checkpointsCount: checkpoints.length,
    decisionsCount: decisions.length,
    tasksCount: tasks.length,
  };
}

/**
 * Pull the latest summaries from the cloud and merge them into the local DB.
 *
 * Uses a last-write-wins strategy on `updated_at` for decisions and tasks.
 * Checkpoints are append-only (never overwrite).
 */
export async function pullSync(
  db: DatabaseSync,
  config: CloudConfig,
): Promise<PullResult> {
  assertEnabled(config);

  const syncState = getSyncState(db, config.workspaceId);
  const cursor = syncState?.last_cursor ?? '0';

  let beforeCursor: string | undefined;
  let skippedBlobs = 0;

  for (let attempt = 0; attempt < 10; attempt++) {
    const pullUrl = buildPullUrl(config, beforeCursor);
    const response = await fetch(
      pullUrl,
      {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cloud sync pull failed: ${response.status} ${body}`);
    }

    const { blob, cursor: newCursor } = (await response.json()) as {
      blob: { id?: string; cursor: string; payload: string } | null;
      cursor: string;
    };

    // Nothing new from server — still success, just nothing to merge
    if (!blob) {
      return { cursor: newCursor, skippedBlobs, merged: { sessions: 0, messages: 0, checkpoints: 0, decisions: 0, tasks: 0 } };
    }

    let data: SyncPayload;
    try {
      data = decryptPayload<SyncPayload>(blob.payload, config.encryptionKey);
    } catch (err) {
      if (config.blobId) {
        throw new Error(`Cloud sync restore failed: checkpoint ${config.blobId} could not be decrypted with this workspace key. Run memory sync auth with the original passphrase for workspace ${config.workspaceId}.`);
      }
      skippedBlobs++;
      beforeCursor = blob.cursor;
      continue;
    }

    const merged = mergePayload(db, data);

    upsertSyncState(db, config.workspaceId, {
      enabled: 1,
      last_cursor: newCursor,
      last_synced_at: Date.now(),
      provider: 'memcode',
    });

    return { cursor: newCursor, skippedBlobs, merged };
  }

  return { cursor, skippedBlobs, merged: { sessions: 0, messages: 0, checkpoints: 0, decisions: 0, tasks: 0 } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertEnabled(config: CloudConfig): void {
  if (!config.endpoint || !config.apiToken || !config.encryptionKey) {
    throw new Error(
      'Cloud sync is not configured. Set endpoint, apiToken, and encryptionKey in your MemCode config.',
    );
  }
}

function buildPullUrl(config: CloudConfig, beforeCursor?: string): string {
  const params = new URLSearchParams({ workspaceId: config.workspaceId });
  if (config.blobId) params.set('blobId', config.blobId);
  else if (beforeCursor) params.set('beforeCursor', beforeCursor);
  else params.set('cursor', '0');
  return `${config.endpoint}/v1/sync/pull?${params.toString()}`;
}

function getSyncState(db: DatabaseSync, workspaceId: string): SyncState | undefined {
  return db
    .prepare('SELECT * FROM sync_state WHERE workspace_id = ?')
    .get(workspaceId) as unknown as SyncState | undefined;
}

function upsertSyncState(
  db: DatabaseSync,
  workspaceId: string,
  state: Omit<SyncState, 'workspace_id'>,
): void {
  db.prepare(`
    INSERT INTO sync_state (workspace_id, enabled, last_cursor, last_synced_at, provider)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      enabled        = excluded.enabled,
      last_cursor    = excluded.last_cursor,
      last_synced_at = excluded.last_synced_at,
      provider       = excluded.provider
  `).run(
    workspaceId,
    state.enabled,
    state.last_cursor ?? null,
    state.last_synced_at ?? null,
    state.provider ?? null,
  );
}

function mergePayload(
  db: DatabaseSync,
  data: SyncPayload,
): PullResult['merged'] {
  const merged = { sessions: 0, messages: 0, checkpoints: 0, decisions: 0, tasks: 0 };

  transaction(db, () => {
    for (const session of data.sessions ?? []) {
      const existing = db
        .prepare('SELECT ended_at FROM sessions WHERE id = ?')
        .get(session.id) as unknown as { ended_at: number | null } | undefined;
      if (!existing) {
        db.prepare(`
          INSERT INTO sessions
            (id, workspace_id, editor, agent, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          session.id, session.workspace_id, session.editor ?? null, session.agent ?? null,
          session.started_at, session.ended_at ?? null,
        );
        merged.sessions++;
      } else if ((session.ended_at ?? 0) > (existing.ended_at ?? 0)) {
        db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
          .run(session.ended_at ?? null, session.id);
        merged.sessions++;
      }
    }

    for (const message of data.messages ?? []) {
      const exists = db
        .prepare('SELECT id FROM messages WHERE id = ?')
        .get(message.id);
      if (!exists) {
        db.prepare(`
          INSERT INTO messages
            (id, session_id, role, content, token_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          message.id, message.session_id, message.role, message.content,
          message.token_count ?? null, message.created_at,
        );
        merged.messages++;
      }
    }

    for (const cp of data.checkpoints) {
      const exists = db
        .prepare('SELECT id FROM checkpoints WHERE id = ?')
        .get(cp.id);
      if (!exists) {
        db.prepare(`
          INSERT INTO checkpoints
            (id, workspace_id, session_id, git_sha, branch, trigger, summary_short, summary_long, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cp.id, cp.workspace_id, cp.session_id ?? null, cp.git_sha ?? null,
          cp.branch ?? null, cp.trigger, cp.summary_short, cp.summary_long, cp.created_at,
        );
        merged.checkpoints++;
      }
    }

    for (const d of data.decisions) {
      const existing = db
        .prepare('SELECT updated_at FROM decisions WHERE id = ?')
        .get(d.id) as unknown as { updated_at: number } | undefined;
      if (!existing) {
        db.prepare(`
          INSERT INTO decisions
            (id, workspace_id, title, rationale, impact, status, checkpoint_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(d.id, d.workspace_id, d.title, d.rationale, d.impact ?? null,
          d.status, d.checkpoint_id ?? null, d.created_at, d.updated_at);
        merged.decisions++;
      } else if (d.updated_at > existing.updated_at) {
        db.prepare(`
          UPDATE decisions SET title=?, rationale=?, impact=?, status=?, updated_at=? WHERE id=?
        `).run(d.title, d.rationale, d.impact ?? null, d.status, d.updated_at, d.id);
        merged.decisions++;
      }
    }

    for (const t of data.tasks) {
      const existing = db
        .prepare('SELECT updated_at FROM tasks WHERE id = ?')
        .get(t.id) as unknown as { updated_at: number } | undefined;
      if (!existing) {
        db.prepare(`
          INSERT INTO tasks
            (id, workspace_id, title, description, status, priority, decision_id, checkpoint_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(t.id, t.workspace_id, t.title, t.description ?? null, t.status,
          t.priority ?? null, t.decision_id ?? null, t.checkpoint_id ?? null,
          t.created_at, t.updated_at);
        merged.tasks++;
      } else if (t.updated_at > existing.updated_at) {
        db.prepare(`
          UPDATE tasks SET title=?, description=?, status=?, priority=?, updated_at=? WHERE id=?
        `).run(t.title, t.description ?? null, t.status, t.priority ?? null, t.updated_at, t.id);
        merged.tasks++;
      }
    }
  });

  return merged;
}
