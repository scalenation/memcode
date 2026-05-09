import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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

      return reply.send({ userId: user.sub, email: user.email, subscription });
    },
  );
}
