import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/client';
import { authenticate } from '../middleware/authenticate';
import { requireActiveSubscription } from '../middleware/require-active-subscription';
import type { TokenPayload } from '../middleware/authenticate';

interface PushBody {
  workspaceId: string;
  payload: string; // base64 AES-256-GCM encrypted blob
  label?: string;  // optional human-readable label (e.g. "12 checkpoints, 3 decisions")
  meta?: Array<{   // unencrypted dashboard timeline summaries
    type?: 'checkpoint' | 'chat';
    id: string;
    role?: 'user' | 'assistant' | 'system';
    trigger?: string | null;
    branch?: string | null;
    git_sha?: string | null;
    summary: string | null;
    created_at: number;
  }>;
}

interface RegisterWorkspaceBody {
  workspaceId: string;
  name?: string;
  machineName?: string;
}

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/sync/workspace
   * Register a workspace for the authenticated user.
   * Safe to call repeatedly (upsert).
   */
  fastify.post<{ Body: RegisterWorkspaceBody }>(
    '/v1/sync/workspace',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Body: RegisterWorkspaceBody }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const { workspaceId, name, machineName } = request.body;

      if (!workspaceId || typeof workspaceId !== 'string') {
        return reply.status(400).send({ error: 'workspaceId is required' });
      }

      // Check ownership if workspace already exists
      const existing = await pool.query(
        'SELECT user_id FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      if ((existing.rowCount ?? 0) > 0 && existing.rows[0].user_id !== user.sub) {
        return reply.status(403).send({ error: 'Workspace belongs to another account' });
      }

      await pool.query(
        `INSERT INTO workspaces (id, user_id, name, machine_name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, workspaces.name),
           machine_name = COALESCE(EXCLUDED.machine_name, workspaces.machine_name)`,
        [workspaceId, user.sub, name ?? null, machineName ?? null],
      );

      return reply.status(200).send({ workspaceId });
    },
  );

  /**
   * POST /v1/sync/push
   * Body: { workspaceId, payload }  — payload is AES-256-GCM encrypted JSON (base64)
   * Returns: { cursor }
   */
  fastify.post<{ Body: PushBody }>(
    '/v1/sync/push',
    { preHandler: [authenticate, requireActiveSubscription], bodyLimit: 25 * 1024 * 1024 },
    async (request: FastifyRequest<{ Body: PushBody }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const { workspaceId, payload, label, meta } = request.body;

      if (!workspaceId || !payload) {
        return reply.status(400).send({ error: 'workspaceId and payload are required' });
      }

      // Verify or auto-register workspace (backward compat with old CLI versions that don't pre-register)
      const ws = await pool.query(
        'SELECT user_id FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      if ((ws.rowCount ?? 0) === 0) {
        // Workspace not yet registered — create it on the fly
        await pool.query(
          'INSERT INTO workspaces (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [workspaceId, user.sub],
        );
      } else if (ws.rows[0].user_id !== user.sub) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const cursor = String(Date.now());
      const ip = request.ip ?? null;
      const userAgent = (request.headers['user-agent'] as string) ?? null;
      const result = await pool.query(
        'INSERT INTO sync_blobs (workspace_id, cursor, payload_encrypted, ip, user_agent, label, meta) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [workspaceId, cursor, payload, ip, userAgent, label ?? null, meta ? JSON.stringify(meta) : null],
      );

      const blobId = (result.rows[0] as { id: string }).id;
      return reply.status(200).send({ cursor, blobId });
    },
  );

  /**
  * GET /v1/sync/pull?workspaceId=...&cursor=...
  * GET /v1/sync/pull?workspaceId=...&beforeCursor=...
   * GET /v1/sync/pull?workspaceId=...&blobId=...  ← point-in-time restore
   * Returns the most recent blob pushed after the given cursor, or a specific blob by ID.
   * cursor defaults to '0' (return latest blob regardless of age).
   */
  fastify.get(
    '/v1/sync/pull',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const { workspaceId, cursor = '0', beforeCursor, blobId } = request.query as Record<string, string>;

      if (!workspaceId) {
        return reply.status(400).send({ error: 'workspaceId query param is required' });
      }

      // Verify workspace ownership (if it exists — if not, just return no data)
      const ws = await pool.query(
        'SELECT user_id FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      if ((ws.rowCount ?? 0) === 0) {
        // Workspace not yet registered — nothing to pull
        return reply.send({ blob: null, cursor });
      }
      if (ws.rows[0].user_id !== user.sub) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      let result;
      if (blobId) {
        // Point-in-time restore: fetch a specific blob by ID
        result = await pool.query(
          `SELECT id, cursor, payload_encrypted
           FROM sync_blobs
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, blobId],
        );
        if (result.rowCount === 0) {
          return reply.status(404).send({ error: 'Checkpoint not found' });
        }
      } else if (beforeCursor) {
        // Return the newest blob older than beforeCursor. This lets clients skip
        // a latest blob that was encrypted with a different local key.
        result = await pool.query(
          `SELECT id, cursor, payload_encrypted
           FROM sync_blobs
           WHERE workspace_id = $1 AND cursor < $2
           ORDER BY cursor DESC
           LIMIT 1`,
          [workspaceId, beforeCursor],
        );
        if (result.rowCount === 0) {
          return reply.send({ blob: null, cursor });
        }
      } else {
        // Return the latest blob pushed after the cursor
        result = await pool.query(
          `SELECT id, cursor, payload_encrypted
           FROM sync_blobs
           WHERE workspace_id = $1 AND cursor > $2
           ORDER BY cursor DESC
           LIMIT 1`,
          [workspaceId, cursor],
        );
        if (result.rowCount === 0) {
          return reply.send({ blob: null, cursor });
        }
      }

      const row = result.rows[0] as { id: string; cursor: string; payload_encrypted: string };
      return reply.send({
        blob: { id: row.id, cursor: row.cursor, payload: row.payload_encrypted },
        cursor: row.cursor,
      });
    },
  );

  /**
   * GET /v1/sync/status?workspaceId=...
   */
  fastify.get(
    '/v1/sync/status',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const { workspaceId } = request.query as Record<string, string>;

      if (!workspaceId) {
        return reply.status(400).send({ error: 'workspaceId query param is required' });
      }

      const ws = await pool.query(
        'SELECT user_id FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      if ((ws.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: 'Workspace not found' });
      }
      if (ws.rows[0].user_id !== user.sub) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const latest = await pool.query(
        `SELECT cursor, created_at FROM sync_blobs
         WHERE workspace_id = $1
         ORDER BY cursor DESC LIMIT 1`,
        [workspaceId],
      );

      const totalBlobs = await pool.query(
        'SELECT COUNT(*) FROM sync_blobs WHERE workspace_id = $1',
        [workspaceId],
      );

      return reply.send({
        workspaceId,
        lastSyncedAt: latest.rowCount ? (latest.rows[0] as { cursor: string; created_at: string }).created_at : null,
        cursor: latest.rowCount ? (latest.rows[0] as { cursor: string }).cursor : '0',
        totalPushes: parseInt((totalBlobs.rows[0] as { count: string }).count, 10),
      });
    },
  );

  /**
   * GET /v1/sync/history
   * Returns all workspaces owned by the authenticated user, each with its checkpoints.
   * Checkpoints are limited to the latest 50 per workspace for performance.
   */
  fastify.get(
    '/v1/sync/history',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;

      const workspaces = await pool.query(
        `SELECT id, name, machine_name, created_at
         FROM workspaces
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [user.sub],
      );

      const result = await Promise.all(
        (workspaces.rows as Array<{ id: string; name: string | null; machine_name: string | null; created_at: string }>)
          .map(async (ws) => {
            const blobs = await pool.query(
              `SELECT id, cursor, created_at, ip, user_agent, label, meta
               FROM sync_blobs
               WHERE workspace_id = $1
               ORDER BY cursor DESC
               LIMIT 50`,
              [ws.id],
            );
            return {
              id: ws.id,
              name: ws.name,
              machineName: ws.machine_name,
              createdAt: ws.created_at,
              checkpoints: (blobs.rows as Array<{
                id: string; cursor: string; created_at: string;
                ip: string | null; user_agent: string | null; label: string | null;
                meta: unknown;
              }>).map(b => ({
                id: b.id,
                cursor: b.cursor,
                createdAt: b.created_at,
                ip: b.ip,
                userAgent: b.user_agent,
                label: b.label,
                meta: b.meta ?? null,
              })),
            };
          }),
      );

      return reply.send({ workspaces: result });
    },
  );
}
