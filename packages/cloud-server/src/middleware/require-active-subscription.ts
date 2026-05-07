import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TokenPayload } from './authenticate';
import { pool } from '../db/client';

/**
 * Fastify pre-handler hook — ensures the authenticated user has an active
 * or trialing subscription. Must run after `authenticate`.
 */
export async function requireActiveSubscription(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = (request as FastifyRequest & { user?: TokenPayload }).user;
  if (!user) {
    reply.status(401).send({ error: 'Not authenticated' });
    return;
  }

  const result = await pool.query(
    `SELECT id FROM subscriptions
     WHERE user_id = $1
       AND status IN ('active', 'trialing')
       AND current_period_end > NOW()
     LIMIT 1`,
    [user.sub],
  );

  if (result.rowCount === 0) {
    reply.status(402).send({
      error: 'Pro subscription required',
      upgradeUrl: '/pricing',
    });
  }
}
