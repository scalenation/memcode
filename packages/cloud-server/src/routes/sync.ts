import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/client';
import { authenticate } from '../middleware/authenticate';
import { requireActiveSubscription } from '../middleware/require-active-subscription';
import type { TokenPayload } from '../middleware/authenticate';

interface PushBody {
  workspaceId: string;
  payload: string; // base64 AES-256-GCM encrypted blob
}

interface RegisterWorkspaceBody {
  workspaceId: string;
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
      const { workspaceId } = request.body;

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
        `INSERT INTO workspaces (id, user_id) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [workspaceId, user.sub],
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
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Body: PushBody }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const { workspaceId, payload } = request.body;

      if (!workspaceId || !payload) {
        return reply.status(400).send({ error: 'workspaceId and payload are required' });
      }

      // Verify workspace ownership
      const ws = await pool.query(
        'SELECT user_id FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      if ((ws.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: 'Workspace not found — register it first with /v1/sync/workspace' });
      }
      if (ws.rows[0].user_id !== user.sub) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const cursor = String(Date.now());
      await pool.query(
        'INSERT INTO sync_blobs (workspace_id, cursor, payload_encrypted) VALUES ($1, $2, $3)',
        [workspaceId, cursor, payload],
      );

      return reply.status(200).send({ cursor });
    },
  );

  /**
   * GET /v1/sync/pull?workspaceId=...&cursor=...
   * Returns the most recent blob pushed after the given cursor.
   * cursor defaults to '0' (return latest blob regardless of age).
   */
  fastify.get(
    '/v1/sync/pull',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      const { workspaceId, cursor = '0' } = request.query as Record<string, string>;

      if (!workspaceId) {
        return reply.status(400).send({ error: 'workspaceId query param is required' });
      }

      // Verify workspace ownership
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

      // Return the latest blob pushed after the cursor
      const result = await pool.query(
        `SELECT cursor, payload_encrypted
         FROM sync_blobs
         WHERE workspace_id = $1 AND cursor > $2
         ORDER BY cursor DESC
         LIMIT 1`,
        [workspaceId, cursor],
      );

      if (result.rowCount === 0) {
        return reply.send({ blob: null, cursor });
      }

      const row = result.rows[0] as { cursor: string; payload_encrypted: string };
      return reply.send({
        blob: { cursor: row.cursor, payload: row.payload_encrypted },
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
}
