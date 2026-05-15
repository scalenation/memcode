import { createD1Client } from './cloudflare/d1.js';
import { loadSyncPayload } from './cloudflare/blob-storage.js';
import { HttpError, authenticateRequest, requireActiveSubscription } from './cloudflare/auth.js';

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = createD1Client(env.DB);

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return json({ name: 'MemCode Cloud API', runtime: 'cloudflare-worker', status: 'ok' });
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        await db.first('SELECT 1 AS ok');
        return json({
          status: 'ok',
          runtime: 'cloudflare-worker',
          appUrl: env.APP_URL ?? null,
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/me') {
        const user = await authenticateRequest(request, env, db);
        return json({ userId: user.sub, email: user.email });
      }

      if (request.method === 'GET' && url.pathname === '/v1/user/workspaces') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);

        const result = await db.all(
          `SELECT
             w.id,
             w.name,
             w.machine_name,
             w.created_at,
             COUNT(b.id) AS blob_count,
             MAX(b.created_at) AS last_synced_at,
             COALESCE(SUM(COALESCE(b.payload_size, LENGTH(b.payload_encrypted))), 0) AS storage_bytes
           FROM workspaces w
           LEFT JOIN sync_blobs b ON b.workspace_id = w.id
           WHERE w.user_id = ?
           GROUP BY w.id, w.name, w.machine_name, w.created_at
           ORDER BY w.created_at DESC`,
          [user.sub],
        );

        const workspaces = result.rows.map((row) => ({
          id: row.id,
          name: row.name ?? null,
          machineName: row.machine_name ?? null,
          createdAt: toIsoString(row.created_at),
          lastSyncedAt: row.last_synced_at == null ? null : toIsoString(row.last_synced_at),
          blobCount: toNumber(row.blob_count),
          storageBytes: toNumber(row.storage_bytes),
        }));

        return json({
          workspaces,
          totalStorageBytes: workspaces.reduce((sum, item) => sum + item.storageBytes, 0),
          totalBlobCount: workspaces.reduce((sum, item) => sum + item.blobCount, 0),
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/sync/status') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) {
          throw new HttpError(400, { error: 'workspaceId query param is required' });
        }

        const workspace = await getOwnedWorkspace(db, workspaceId, user.sub, true);
        if (!workspace) {
          throw new HttpError(404, { error: 'Workspace not found' });
        }

        const latest = await db.first(
          `SELECT cursor, created_at
           FROM sync_blobs
           WHERE workspace_id = ?
           ORDER BY cursor DESC
           LIMIT 1`,
          [workspaceId],
        );
        const totalPushes = await db.value(
          'SELECT COUNT(*) AS count FROM sync_blobs WHERE workspace_id = ?',
          [workspaceId],
        );

        return json({
          workspaceId,
          lastSyncedAt: latest ? toIsoString(latest.created_at) : null,
          cursor: latest?.cursor ?? '0',
          totalPushes: toNumber(totalPushes),
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/sync/pull') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const workspaceId = url.searchParams.get('workspaceId');
        const cursor = url.searchParams.get('cursor') ?? '0';
        const beforeCursor = url.searchParams.get('beforeCursor');
        const blobId = url.searchParams.get('blobId');

        if (!workspaceId) {
          throw new HttpError(400, { error: 'workspaceId query param is required' });
        }

        const workspace = await getOwnedWorkspace(db, workspaceId, user.sub, false);
        if (!workspace) {
          return json({ blob: null, cursor });
        }

        let row = null;
        if (blobId) {
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND id = ?
             LIMIT 1`,
            [workspaceId, blobId],
          );
          if (!row) {
            throw new HttpError(404, { error: 'Checkpoint not found' });
          }
        } else if (beforeCursor) {
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND cursor < ?
             ORDER BY cursor DESC
             LIMIT 1`,
            [workspaceId, beforeCursor],
          );
          if (!row) {
            return json({ blob: null, cursor });
          }
        } else {
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND cursor > ?
             ORDER BY cursor DESC
             LIMIT 1`,
            [workspaceId, cursor],
          );
          if (!row) {
            return json({ blob: null, cursor });
          }
        }

        const payload = await loadSyncPayload(env, row);
        if (!payload) {
          throw new HttpError(500, { error: 'Stored sync payload is unavailable' });
        }

        return json({
          blob: { id: row.id, cursor: row.cursor, payload },
          cursor: row.cursor,
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/sync/history') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);

        const workspaces = await db.all(
          `SELECT id, name, machine_name, created_at
           FROM workspaces
           WHERE user_id = ?
           ORDER BY created_at DESC`,
          [user.sub],
        );

        const result = await Promise.all(workspaces.rows.map(async (workspace) => {
          const blobs = await db.all(
            `SELECT id, cursor, created_at, ip, user_agent, label, meta
             FROM sync_blobs
             WHERE workspace_id = ?
             ORDER BY cursor DESC
             LIMIT 20`,
            [workspace.id],
          );

          return {
            id: workspace.id,
            name: workspace.name ?? null,
            machineName: workspace.machine_name ?? null,
            createdAt: toIsoString(workspace.created_at),
            checkpoints: blobs.rows.map((blob) => ({
              id: blob.id,
              cursor: blob.cursor,
              createdAt: toIsoString(blob.created_at),
              ip: blob.ip ?? null,
              userAgent: blob.user_agent ?? null,
              label: blob.label ?? null,
              meta: parseCheckpointMeta(blob.meta),
            })),
          };
        }));

        return json({ workspaces: result });
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.body, { status: error.status });
      }

      console.error(error);
      return json({ error: 'Internal server error' }, { status: 500 });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json(
      {
        error: 'Cloudflare worker routes are not fully ported yet.',
      },
      { status: 501 },
    );
  },

  async scheduled(_event, _env, _ctx) {
    console.warn('Scheduled brain compaction is not ported yet.');
  },
};

async function getOwnedWorkspace(db, workspaceId, userId, requireExisting) {
  const workspace = await db.first('SELECT user_id FROM workspaces WHERE id = ? LIMIT 1', [workspaceId]);
  if (!workspace) {
    if (requireExisting) return null;
    return null;
  }
  if (workspace.user_id !== userId) {
    throw new HttpError(403, { error: 'Access denied' });
  }
  return workspace;
}

function parseCheckpointMeta(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 6) : null;
  } catch {
    return null;
  }
}

function toIsoString(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && String(numeric) === String(value)) {
    return new Date(numeric).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const numeric = Number(value ?? 0);
  return Number.isNaN(numeric) ? 0 : numeric;
}