import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint, Decision, Task, SyncState } from '@memcode/core';
import { transaction } from '@memcode/core';
import { encryptPayload, decryptPayload } from './client';
import type { CloudConfig, SyncPayload } from './client';

export interface PushResult {
  cursor: string;
  uploadedAt: number;
  checkpointsCount: number;
  decisionsCount: number;
  tasksCount: number;
}

export interface PullResult {
  cursor: string;
  merged: {
    checkpoints: number;
    decisions: number;
    tasks: number;
  };
}

/**
 * Push workspace summaries and metadata to the cloud API.
 *
 * All data is encrypted client-side before transmission.
 * Only summaries and structured metadata are uploaded — no raw message transcripts.
 *
 * NOTE: This is a stub implementation. Wire up `config.endpoint` to the
 * live API gateway when the cloud backend is available.
 */
export async function pushSync(
  db: DatabaseSync,
  config: CloudConfig,
): Promise<PushResult> {
  assertEnabled(config);

  const syncState = getSyncState(db, config.workspaceId);
  const since = syncState?.last_synced_at ?? 0;

  // Ensure the workspace is registered on the server before pushing
  await fetch(`${config.endpoint}/v1/sync/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ workspaceId: config.workspaceId }),
  });

  // Collect items modified since last sync
  const checkpoints = db
    .prepare(
      'SELECT * FROM checkpoints WHERE workspace_id = ? AND created_at > ? ORDER BY created_at',
    )
    .all(config.workspaceId, since) as unknown as Checkpoint[];

  const decisions = db
    .prepare(
      'SELECT * FROM decisions WHERE workspace_id = ? AND updated_at > ? ORDER BY created_at',
    )
    .all(config.workspaceId, since) as unknown as Decision[];

  const tasks = db
    .prepare(
      'SELECT * FROM tasks WHERE workspace_id = ? AND updated_at > ? ORDER BY created_at',
    )
    .all(config.workspaceId, since) as unknown as Task[];

  const now = Date.now();
  const cursor = String(now);

  const payload: SyncPayload = {
    workspaceId: config.workspaceId,
    checkpoints,
    decisions,
    tasks,
    cursor,
    encryptedAt: now,
  };

  const encrypted = encryptPayload(payload, config.encryptionKey);

  // HTTP POST to cloud API
  const response = await fetch(`${config.endpoint}/v1/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ workspaceId: config.workspaceId, payload: encrypted }),
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

  const pullUrl = config.blobId
    ? `${config.endpoint}/v1/sync/pull?workspaceId=${encodeURIComponent(config.workspaceId)}&blobId=${encodeURIComponent(config.blobId)}`
    : `${config.endpoint}/v1/sync/pull?workspaceId=${encodeURIComponent(config.workspaceId)}&cursor=${encodeURIComponent(cursor)}`;

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
    blob: { cursor: string; payload: string } | null;
    cursor: string;
  };

  // Nothing new from server — still success, just nothing to merge
  if (!blob) {
    return { cursor: newCursor, merged: { checkpoints: 0, decisions: 0, tasks: 0 } };
  }

  const data = decryptPayload<SyncPayload>(blob.payload, config.encryptionKey);

  const merged = { checkpoints: 0, decisions: 0, tasks: 0 };

  transaction(db, () => {
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

    upsertSyncState(db, config.workspaceId, {
      enabled: 1,
      last_cursor: newCursor,
      last_synced_at: Date.now(),
      provider: 'memcode',
    });
});

  return { cursor: newCursor, merged };
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
