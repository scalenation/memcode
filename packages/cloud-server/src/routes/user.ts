import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { pool } from '../db/client';
import { authenticate } from '../middleware/authenticate';
import type { TokenPayload } from '../middleware/authenticate';
import { config } from '../config';

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
      try {
        const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [user.sub]);
        userName = (userResult.rows[0] as { name: string | null } | undefined)?.name ?? null;
      } catch {
        // name column may not exist yet — non-fatal
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

      return reply.send({ userId: user.sub, email: user.email, name: userName, subscription });
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
}
