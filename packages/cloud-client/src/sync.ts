import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Checkpoint, Decision, Message, Session, Task, SyncState } from '@memcode/core';
import { transaction } from '@memcode/core';
import { encryptPayload, decryptPayload } from './client';
import type { CloudConfig, ProjectBrain, SyncPayload } from './client';

const AGENT_CATEGORIES = ['decision', 'bugfix', 'feature', 'discovery'] as const;

const DIRECT_PUSH_LIMIT_BYTES = 750_000;
const PUSH_CHUNK_SIZE = 550_000;

export interface PushResult {
  cursor: string;
  uploadedAt: number;
  sessionsCount: number;
  messagesCount: number;
  checkpointsCount: number;
  decisionsCount: number;
  tasksCount: number;
  brainMilestonesCount: number;
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

  // ── Dirty check ──────────────────────────────────────────────────────────
  // Skip push if nothing has changed since the last push.
  // Checks both created_at AND updated_at so task/decision edits are caught.
  const syncState = getSyncState(db, config.workspaceId);
  const lastSyncedAt = syncState?.last_synced_at ?? 0;
  if (lastSyncedAt > 0) {
    const anyNew =
      db.prepare(`SELECT 1 FROM checkpoints WHERE workspace_id = ? AND created_at > ? LIMIT 1`).get(config.workspaceId, lastSyncedAt) ||
      db.prepare(`SELECT 1 FROM decisions  WHERE workspace_id = ? AND (created_at > ? OR updated_at > ?) LIMIT 1`).get(config.workspaceId, lastSyncedAt, lastSyncedAt) ||
      db.prepare(`SELECT 1 FROM tasks      WHERE workspace_id = ? AND (created_at > ? OR updated_at > ?) LIMIT 1`).get(config.workspaceId, lastSyncedAt, lastSyncedAt) ||
      db.prepare(`SELECT 1 FROM sessions   WHERE workspace_id = ? AND started_at  > ? LIMIT 1`).get(config.workspaceId, lastSyncedAt);
    if (!anyNew) {
      return {
        cursor: syncState?.last_cursor ?? String(lastSyncedAt),
        uploadedAt: lastSyncedAt,
        sessionsCount: 0,
        messagesCount: 0,
        checkpointsCount: 0,
        decisionsCount: 0,
        tasksCount: 0,
        brainMilestonesCount: 0,
      };
    }
  }

  // Ensure the workspace is registered on the server before pushing
  await fetch(`${config.endpoint}/v1/sync/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body: JSON.stringify({ workspaceId: config.workspaceId }),
  });

  // Full snapshot — the server replaces the previous blob each time, so the
  // pull side always gets a single complete blob with all records. No history
  // accumulates on the server.
  const checkpoints = db
    .prepare('SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at')
    .all(config.workspaceId) as unknown as Checkpoint[];

  const decisions = db
    .prepare('SELECT * FROM decisions WHERE workspace_id = ? ORDER BY created_at')
    .all(config.workspaceId) as unknown as Decision[];

  const tasks = db
    .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at')
    .all(config.workspaceId) as unknown as Task[];

  // Session metadata only — no message content in the cloud payload.
  const sessions = db
    .prepare('SELECT id, workspace_id, editor, agent, source, provider, model, task_label, category, started_at, ended_at FROM sessions WHERE workspace_id = ? ORDER BY started_at')
    .all(config.workspaceId) as unknown as Session[];

  const now = Date.now();
  const cursor = String(now);

  const payload: SyncPayload = {
    workspaceId: config.workspaceId,
    sessions,
    // messages intentionally omitted — message bodies are local-only
    checkpoints,
    decisions,
    tasks,
    cursor,
    encryptedAt: now,
  };

  const encrypted = encryptPayload(payload, config.encryptionKey);
  const brain = buildProjectBrain(config.workspaceId, checkpoints, decisions, tasks, sessions, [], now);

  // Dashboard metadata for the web UI.
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
    ...brain.milestones.map(milestone => ({
      type: 'milestone',
      id: milestone.id,
      trigger: milestone.trigger ?? null,
      branch: milestone.branch ?? null,
      git_sha: milestone.gitSha ?? null,
      summary: milestone.title,
      created_at: milestone.createdAt,
    })),
  ].sort((a, b) => b.created_at - a.created_at);

  const { cursor: serverCursor } = await pushEncryptedSnapshot(config, encrypted, meta, brain);

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
    messagesCount: 0,
    checkpointsCount: checkpoints.length,
    decisionsCount: decisions.length,
    tasksCount: tasks.length,
    brainMilestonesCount: brain.milestones.length,
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

  const pullUrl = buildPullUrl(config);
  const response = await fetch(pullUrl, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloud sync pull failed: ${response.status} ${body}`);
  }

  const { blob, cursor: newCursor } = (await response.json()) as {
    blob: { id?: string; cursor: string; payload: string } | null;
    cursor: string;
  };

  if (!blob) {
    return { cursor: newCursor, merged: { sessions: 0, messages: 0, checkpoints: 0, decisions: 0, tasks: 0 } };
  }

  let data: SyncPayload;
  try {
    data = decryptPayload<SyncPayload>(blob.payload, config.encryptionKey);
  } catch {
    if (config.blobId) {
      throw new Error(`Cloud sync restore failed: checkpoint ${config.blobId} could not be decrypted with this workspace key. Run memory sync auth with the original passphrase for workspace ${config.workspaceId}.`);
    }
    return { cursor: syncState?.last_cursor ?? '0', merged: { sessions: 0, messages: 0, checkpoints: 0, decisions: 0, tasks: 0 } };
  }

  const merged = mergePayload(db, data);

  // Update last_cursor so we know the server state. Do NOT update last_synced_at —
  // that is owned by pushSync so the dirty check stays accurate.
  upsertSyncState(db, config.workspaceId, {
    enabled: 1,
    last_cursor: newCursor,
    last_synced_at: syncState?.last_synced_at ?? undefined,
    provider: 'memcode',
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

function buildPullUrl(config: CloudConfig, beforeCursor?: string): string {
  const params = new URLSearchParams({ workspaceId: config.workspaceId });
  if (config.blobId) params.set('blobId', config.blobId);
  else if (beforeCursor) params.set('beforeCursor', beforeCursor);
  else params.set('cursor', '0');
  return `${config.endpoint}/v1/sync/pull?${params.toString()}`;
}

async function pushEncryptedSnapshot(
  config: CloudConfig,
  encrypted: string,
  meta: unknown[],
  brain: ProjectBrain,
): Promise<{ cursor: string; blobId?: string }> {
  const body = JSON.stringify({ workspaceId: config.workspaceId, payload: encrypted, meta, brain });
  if (Buffer.byteLength(body, 'utf-8') <= DIRECT_PUSH_LIMIT_BYTES) {
    return postJson<{ cursor: string; blobId?: string }>(config, '/v1/sync/push', body, 'Cloud sync push failed');
  }

  const uploadId = randomUUID();
  await uploadChunks(config, uploadId, 'payload', encrypted);
  await uploadChunks(config, uploadId, 'meta', JSON.stringify(meta));

  return postJson<{ cursor: string; blobId?: string }>(
    config,
    '/v1/sync/push-finalize',
    JSON.stringify({ workspaceId: config.workspaceId, uploadId, brain }),
    'Cloud sync finalize failed',
  );
}

async function uploadChunks(
  config: CloudConfig,
  uploadId: string,
  kind: 'payload' | 'meta',
  data: string,
): Promise<void> {
  const totalChunks = Math.max(1, Math.ceil(data.length / PUSH_CHUNK_SIZE));
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const chunk = data.slice(chunkIndex * PUSH_CHUNK_SIZE, (chunkIndex + 1) * PUSH_CHUNK_SIZE);
    await postJson(
      config,
      '/v1/sync/push-chunk',
      JSON.stringify({
        workspaceId: config.workspaceId,
        uploadId,
        kind,
        chunkIndex,
        totalChunks,
        data: chunk,
      }),
      `Cloud sync ${kind} chunk ${chunkIndex + 1}/${totalChunks} failed`,
    );
  }
}

async function postJson<T>(
  config: CloudConfig,
  path: string,
  body: string,
  errorPrefix: string,
): Promise<T> {
  const response = await fetch(`${config.endpoint}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiToken}`,
    },
    body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`${errorPrefix}: ${response.status} ${responseBody}`);
  }

  return response.json() as Promise<T>;
}

function buildProjectBrain(
  workspaceId: string,
  checkpoints: Checkpoint[],
  decisions: Decision[],
  tasks: Task[],
  sessions: Session[],
  messages: Message[],
  generatedAt: number,
): ProjectBrain {
  const recentCheckpoints = [...checkpoints]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 12);
  const recentDecisions = [...decisions]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 12);
  const recentTasks = [...tasks]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 20);
  const openTasks = recentTasks.filter(task => task.status !== 'done' && task.status !== 'cancelled');
  const completedTasks = tasks.filter(task => task.status === 'done');

  const summaryParts = [
    recentCheckpoints[0]?.summary_short || 'No checkpoints recorded yet.',
  ];
  if (recentDecisions.length > 0) {
    summaryParts.push(`Recent decisions: ${recentDecisions.slice(0, 3).map(decision => decision.title).join('; ')}.`);
  }
  if (openTasks.length > 0) {
    summaryParts.push(`Current focus: ${openTasks.slice(0, 4).map(task => task.title).join('; ')}.`);
  }

  return {
    workspaceId,
    generatedAt,
    summary: summaryParts.filter(Boolean).join(' '),
    milestones: recentCheckpoints.map(checkpoint => ({
      id: checkpoint.id,
      title: checkpoint.summary_short,
      detail: compactCheckpointDetail(checkpoint.summary_long, checkpoint.summary_short),
      trigger: checkpoint.trigger,
      branch: checkpoint.branch ?? null,
      gitSha: checkpoint.git_sha ?? null,
      createdAt: checkpoint.created_at,
    })),
    decisions: recentDecisions.map(decision => ({
      id: decision.id,
      title: decision.title,
      rationale: decision.rationale,
      impact: decision.impact,
      status: decision.status,
      updatedAt: decision.updated_at,
    })),
    tasks: recentTasks.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      updatedAt: task.updated_at,
    })),
    agentTelemetry: buildAgentTelemetry(sessions, messages),
    stats: {
      checkpointCount: checkpoints.length,
      decisionCount: decisions.length,
      taskCount: tasks.length,
      openTaskCount: openTasks.length,
      completedTaskCount: completedTasks.length,
    },
  };
}

function buildAgentTelemetry(sessions: Session[], messages: Message[]) {
  const sessionStats = new Map<string, { messageCount: number; estimatedTokens: number; lastMessageAt: number }>();

  for (const message of messages) {
    const existing = sessionStats.get(message.session_id) ?? { messageCount: 0, estimatedTokens: 0, lastMessageAt: 0 };
    existing.messageCount += 1;
    existing.estimatedTokens += Number(message.token_count ?? 0);
    existing.lastMessageAt = Math.max(existing.lastMessageAt, Number(message.created_at ?? 0));
    sessionStats.set(message.session_id, existing);
  }

  const recent = sessions
    .map((session) => {
      const stats = sessionStats.get(session.id) ?? { messageCount: 0, estimatedTokens: 0, lastMessageAt: Number(session.ended_at ?? session.started_at ?? 0) };
      return {
        id: session.id,
        agent: session.agent ?? session.source ?? session.editor ?? 'Unknown agent',
        source: session.source ?? null,
        provider: session.provider ?? null,
        model: session.model ?? null,
        taskLabel: session.task_label ?? null,
        category: normalizeCategory(session.category),
        messageCount: stats.messageCount,
        estimatedTokens: stats.estimatedTokens,
        startedAt: Number(session.started_at ?? 0),
        lastMessageAt: Math.max(stats.lastMessageAt, Number(session.ended_at ?? session.started_at ?? 0)),
      };
    })
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, 12);

  const summary = {
    sessionCount: sessions.length,
    messageCount: messages.length,
    estimatedTokens: messages.reduce((sum, message) => sum + Number(message.token_count ?? 0), 0),
    knownModelSessions: sessions.filter((session) => Boolean(session.model)).length,
    unknownModelSessions: sessions.filter((session) => !session.model).length,
    knownProviderSessions: sessions.filter((session) => Boolean(session.provider)).length,
    taskLabeledSessions: sessions.filter((session) => Boolean(session.task_label)).length,
  };

  const byCategory = AGENT_CATEGORIES.map((category) => {
    const matching = recent.filter((session) => session.category === category);
    return {
      category,
      sessionCount: matching.length,
      messageCount: matching.reduce((sum, session) => sum + session.messageCount, 0),
      estimatedTokens: matching.reduce((sum, session) => sum + session.estimatedTokens, 0),
    };
  });

  const byAgent = aggregateUsage(recent, (session) => session.agent, (key, bucket) => ({
    agent: key,
    sessionCount: bucket.sessionCount,
    messageCount: bucket.messageCount,
    estimatedTokens: bucket.estimatedTokens,
  }));

  const byModel = aggregateUsage(recent, (session) => `${session.provider ?? ''}::${session.model ?? ''}`, (_key, bucket) => ({
    model: bucket.model,
    provider: bucket.provider,
    sessionCount: bucket.sessionCount,
    messageCount: bucket.messageCount,
    estimatedTokens: bucket.estimatedTokens,
  }));

  return {
    summary,
    byCategory,
    byAgent,
    byModel,
    recent,
  };
}

function aggregateUsage<T>(
  sessions: Array<{
    agent: string;
    provider: string | null;
    model: string | null;
    messageCount: number;
    estimatedTokens: number;
  }>,
  keyFn: (session: { agent: string; provider: string | null; model: string | null; messageCount: number; estimatedTokens: number }) => string,
  mapFn: (key: string, bucket: { sessionCount: number; messageCount: number; estimatedTokens: number; provider: string | null; model: string | null }) => T,
): T[] {
  const buckets = new Map<string, { sessionCount: number; messageCount: number; estimatedTokens: number; provider: string | null; model: string | null }>();

  for (const session of sessions) {
    const key = keyFn(session);
    const bucket = buckets.get(key) ?? { sessionCount: 0, messageCount: 0, estimatedTokens: 0, provider: session.provider, model: session.model };
    bucket.sessionCount += 1;
    bucket.messageCount += session.messageCount;
    bucket.estimatedTokens += session.estimatedTokens;
    bucket.provider ??= session.provider;
    bucket.model ??= session.model;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => mapFn(key, bucket))
    .sort((a, b) => {
      const left = a as { estimatedTokens?: number; sessionCount?: number };
      const right = b as { estimatedTokens?: number; sessionCount?: number };
      return Number(right.estimatedTokens ?? right.sessionCount ?? 0) - Number(left.estimatedTokens ?? left.sessionCount ?? 0);
    })
    .slice(0, 8);
}

function normalizeCategory(category: unknown): 'decision' | 'bugfix' | 'feature' | 'discovery' {
  return AGENT_CATEGORIES.includes(category as (typeof AGENT_CATEGORIES)[number])
    ? category as 'decision' | 'bugfix' | 'feature' | 'discovery'
    : 'discovery';
}

function compactCheckpointDetail(summaryLong: string, summaryShort: string): string {
  const lines = summaryLong
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !/^(trigger:|branch:|commit:|changed files|stats:)/i.test(line))
    .filter(line => !/^[madrcu?]\s+/i.test(line));

  const compact = lines.join(' ').replace(/^message:\s*/i, '').trim();
  if (!compact) return summaryShort;
  if (/files changed|\s\|\s|packages\//i.test(compact)) return summaryShort;
  return compact.length <= 280 ? compact : `${compact.slice(0, 277)}...`;
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
            (id, workspace_id, editor, agent, source, provider, model, task_label, category, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          session.id, session.workspace_id, session.editor ?? null, session.agent ?? null,
          session.source ?? null, session.provider ?? null, session.model ?? null,
          session.task_label ?? null, session.category ?? null,
          session.started_at, session.ended_at ?? null,
        );
        merged.sessions++;
      } else if ((session.ended_at ?? 0) > (existing.ended_at ?? 0)) {
        db.prepare(`
          UPDATE sessions
          SET ended_at = ?,
              source = COALESCE(source, ?),
              provider = COALESCE(provider, ?),
              model = COALESCE(model, ?),
              task_label = COALESCE(task_label, ?),
              category = COALESCE(category, ?)
          WHERE id = ?
        `)
          .run(
            session.ended_at ?? null,
            session.source ?? null,
            session.provider ?? null,
            session.model ?? null,
            session.task_label ?? null,
            session.category ?? null,
            session.id,
          );
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
