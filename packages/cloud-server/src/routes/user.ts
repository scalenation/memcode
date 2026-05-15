import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { pool } from '../db/client';
import { authenticate } from '../middleware/authenticate';
import { requireActiveSubscription } from '../middleware/require-active-subscription';
import type { TokenPayload } from '../middleware/authenticate';
import { config } from '../config';
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODELS,
  encryptSecret,
  isSupportedOpenRouterModel,
} from '../openrouter';

const stripe = new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' });

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/user/profile
   * Returns user details + active subscription info.
   */
  fastify.get(
    '/v1/user/profile',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;

      let userName: string | null = null;
      let hasPassword = false;
      let hasOpenRouterKey = false;
      let openRouterModel = DEFAULT_OPENROUTER_MODEL;
      try {
        const userResult = await pool.query(
          'SELECT name, password_hash, openrouter_api_key_encrypted, openrouter_model FROM users WHERE id = $1',
          [user.sub],
        );
        const userRow = (userResult.rows[0] as {
          name: string | null;
          password_hash: string;
          openrouter_api_key_encrypted: string | null;
          openrouter_model: string | null;
        } | undefined);
        userName = userRow?.name ?? null;
        hasPassword = !!userRow && userRow.password_hash !== '!LOCKED' && userRow.password_hash !== '!OAUTH';
        hasOpenRouterKey = Boolean(userRow?.openrouter_api_key_encrypted);
        openRouterModel = userRow?.openrouter_model ?? DEFAULT_OPENROUTER_MODEL;
      } catch {
        // non-fatal
      }

      const subResult = await pool.query(
        `SELECT status, stripe_price_id, current_period_end
         FROM subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [user.sub],
      );

      const sub = subResult.rows[0] as
        | { status: string; stripe_price_id: string; current_period_end: string }
        | undefined;

      let subscription = null;
      if (sub) {
        const planName =
          sub.stripe_price_id === config.stripePriceIdYearly ? 'Pro Yearly' : 'Pro Monthly';
        subscription = {
          status: sub.status,
          planName,
          currentPeriodEnd: sub.current_period_end,
        };
      }

      return reply.send({
        userId: user.sub,
        email: user.email,
        name: userName,
        subscription,
        hasPassword,
        aiSettings: {
          hasOpenRouterKey,
          openRouterModel,
          availableModels: OPENROUTER_MODELS,
        },
      });
    },
  );

  /**
   * PUT /v1/user/profile
   * Update display name and/or password.
   * Body: { name?: string, currentPassword?: string, newPassword?: string }
   */
  fastify.put<{ Body: { name?: string; currentPassword?: string; newPassword?: string } }>(
    '/v1/user/profile',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Body: { name?: string; currentPassword?: string; newPassword?: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Body: { name?: string; currentPassword?: string; newPassword?: string } }> & { user: TokenPayload }).user;
      const { name, currentPassword, newPassword } = request.body;

      if (name !== undefined) {
        const trimmed = name.trim().slice(0, 128);
        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [trimmed || null, user.sub]);
      }

      if (currentPassword !== undefined || newPassword !== undefined) {
        if (!currentPassword || !newPassword) {
          return reply.status(400).send({ error: 'Both currentPassword and newPassword are required.' });
        }
        if (newPassword.length < 8) {
          return reply.status(400).send({ error: 'New password must be at least 8 characters.' });
        }
        const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.sub]);
        const row = r.rows[0] as { password_hash: string } | undefined;
        if (!row || row.password_hash === '!LOCKED' || row.password_hash === '!OAUTH') {
          return reply.status(400).send({ error: 'Password change is not available for SSO accounts.' });
        }
        const valid = await bcrypt.compare(currentPassword, row.password_hash);
        if (!valid) return reply.status(401).send({ error: 'Current password is incorrect.' });
        const newHash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.sub]);
      }

      return reply.send({ ok: true });
    },
  );

  fastify.put<{ Body: { openRouterApiKey?: string; openRouterModel?: string; clearOpenRouterKey?: boolean } }>(
    '/v1/user/ai-settings',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Body: { openRouterApiKey?: string; openRouterModel?: string; clearOpenRouterKey?: boolean } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Body: { openRouterApiKey?: string; openRouterModel?: string; clearOpenRouterKey?: boolean } }> & { user: TokenPayload }).user;
      const openRouterApiKey = request.body.openRouterApiKey?.trim();
      const openRouterModel = request.body.openRouterModel?.trim() || DEFAULT_OPENROUTER_MODEL;
      const clearOpenRouterKey = Boolean(request.body.clearOpenRouterKey);

      if (!isSupportedOpenRouterModel(openRouterModel)) {
        return reply.status(400).send({ error: 'Unsupported OpenRouter model selection.' });
      }

      const encryptedKey = openRouterApiKey ? encryptSecret(openRouterApiKey) : null;
      if (clearOpenRouterKey && !encryptedKey) {
        await pool.query(
          'UPDATE users SET openrouter_api_key_encrypted = NULL, openrouter_model = $1 WHERE id = $2',
          [openRouterModel, user.sub],
        );
      } else {
        await pool.query(
          `UPDATE users
           SET openrouter_api_key_encrypted = COALESCE($1, openrouter_api_key_encrypted),
               openrouter_model = $2
           WHERE id = $3`,
          [encryptedKey, openRouterModel, user.sub],
        );
      }

      const current = await pool.query(
        'SELECT openrouter_api_key_encrypted, openrouter_model FROM users WHERE id = $1',
        [user.sub],
      );
      const row = current.rows[0] as { openrouter_api_key_encrypted: string | null; openrouter_model: string | null } | undefined;
      return reply.send({
        ok: true,
        aiSettings: {
          hasOpenRouterKey: Boolean(row?.openrouter_api_key_encrypted),
          openRouterModel: row?.openrouter_model ?? DEFAULT_OPENROUTER_MODEL,
          availableModels: OPENROUTER_MODELS,
        },
      });
    },
  );

  // ── Workspaces ─────────────────────────────────────────────────────────────

  /**
   * GET /v1/user/workspaces
   * Returns workspace list with blob count, storage estimate, and last sync time.
   */
  fastify.get(
    '/v1/user/workspaces',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;

      const result = await pool.query(
        `SELECT
           w.id,
           w.name,
           w.machine_name,
           w.created_at,
           COUNT(b.id)::int AS blob_count,
           MAX(b.created_at) AS last_synced_at,
           COALESCE(SUM(LENGTH(b.payload_encrypted)), 0)::bigint AS storage_bytes
         FROM workspaces w
         LEFT JOIN sync_blobs b ON b.workspace_id = w.id
         WHERE w.user_id = $1
         GROUP BY w.id, w.name, w.machine_name, w.created_at
         ORDER BY w.created_at DESC`,
        [user.sub],
      );

      type WsRow = { id: string; name: string | null; machine_name: string | null; created_at: string; blob_count: number; last_synced_at: string | null; storage_bytes: string };
      const rows = result.rows as WsRow[];
      const workspaces = rows.map(r => ({
        id: r.id,
        name: r.name,
        machineName: r.machine_name,
        createdAt: r.created_at,
        lastSyncedAt: r.last_synced_at,
        blobCount: r.blob_count,
        storageBytes: parseInt(r.storage_bytes, 10),
      }));

      return reply.send({
        workspaces,
        totalStorageBytes: workspaces.reduce((s, w) => s + w.storageBytes, 0),
        totalBlobCount: workspaces.reduce((s, w) => s + w.blobCount, 0),
      });
    },
  );

  /**
   * DELETE /v1/user/workspaces/:workspaceId
   * Deletes a workspace and all its blobs.
   */
  fastify.delete<{ Params: { workspaceId: string } }>(
    '/v1/user/workspaces/:workspaceId',
    { preHandler: [authenticate, requireActiveSubscription] },
    async (request: FastifyRequest<{ Params: { workspaceId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { workspaceId: string } }> & { user: TokenPayload }).user;
      const { workspaceId } = request.params;

      const ws = await pool.query('SELECT user_id FROM workspaces WHERE id = $1', [workspaceId]);
      if ((ws.rowCount ?? 0) === 0) return reply.status(404).send({ error: 'Workspace not found' });
      if ((ws.rows[0] as { user_id: string }).user_id !== user.sub) return reply.status(403).send({ error: 'Forbidden' });

      await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      return reply.send({ ok: true });
    },
  );

  // ── Sessions ───────────────────────────────────────────────────────────────

  /**
   * GET /v1/user/sessions
   * Returns active (non-revoked) sessions for the current user.
   */
  fastify.get(
    '/v1/user/sessions',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;

      const result = await pool.query(
        `SELECT id, ip, user_agent, created_at, last_seen_at
         FROM sessions
         WHERE user_id = $1 AND revoked = FALSE
         ORDER BY last_seen_at DESC
         LIMIT 30`,
        [user.sub],
      );

      type SessRow = { id: string; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string };
      const sessions = (result.rows as SessRow[]).map(r => ({
        id: r.id,
        ip: r.ip,
        userAgent: r.user_agent,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        isCurrent: r.id === user.sid,
      }));

      return reply.send({ sessions });
    },
  );

  /**
   * DELETE /v1/user/sessions/:sessionId
   * Revokes a specific session.
   */
  fastify.delete<{ Params: { sessionId: string } }>(
    '/v1/user/sessions/:sessionId',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Params: { sessionId: string } }> & { user: TokenPayload }).user;
      const { sessionId } = request.params;

      const r = await pool.query('SELECT user_id FROM sessions WHERE id = $1', [sessionId]);
      if ((r.rowCount ?? 0) === 0) return reply.status(404).send({ error: 'Session not found' });
      if ((r.rows[0] as { user_id: string }).user_id !== user.sub) return reply.status(403).send({ error: 'Forbidden' });

      await pool.query('UPDATE sessions SET revoked = TRUE WHERE id = $1', [sessionId]);
      return reply.send({ ok: true });
    },
  );

  // ── Account deletion ───────────────────────────────────────────────────────

  /**
   * DELETE /v1/user/account
   * Cancels active subscription and permanently deletes the user account and all data.
   */
  fastify.delete(
    '/v1/user/account',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;

      // Cancel any active Stripe subscription first (best-effort)
      try {
        const subResult = await pool.query(
          `SELECT stripe_subscription_id FROM subscriptions
           WHERE user_id = $1 AND status IN ('active', 'trialing')
           LIMIT 1`,
          [user.sub],
        );
        if ((subResult.rowCount ?? 0) > 0) {
          const subId = (subResult.rows[0] as { stripe_subscription_id: string }).stripe_subscription_id;
          await stripe.subscriptions.cancel(subId);
        }
      } catch { /* non-fatal — proceed with deletion */ }

      // Delete user — cascades to subscriptions, workspaces, blobs, sessions
      await pool.query('DELETE FROM users WHERE id = $1', [user.sub]);
      return reply.send({ ok: true });
    },
  );
}
