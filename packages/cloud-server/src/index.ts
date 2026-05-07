import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { config } from './config';
import { pool } from './db/client';
import { authRoutes } from './routes/auth';
import { syncRoutes } from './routes/sync';
import { billingRoutes } from './routes/billing';

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

// Override the default JSON parser to also capture the raw buffer (needed for
// Stripe webhook signature verification).
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  function (_req, body, done) {
    try {
      const parsed = JSON.parse((body as Buffer).toString()) as unknown;
      // Stash raw buffer on request so the webhook route can access it
      Object.assign(_req, { rawBody: body });
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

async function main() {
  // CORS — allow CLI and browser requests
  await fastify.register(cors, {
    origin: [config.appUrl, 'https://memcode.dev', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Serve landing page static files
  const landingPath = join(__dirname, '../../landing');
  try {
    await fastify.register(fastifyStatic, {
      root: landingPath,
      prefix: '/',
      decorateReply: false,
    });
  } catch {
    fastify.log.warn('Landing package not found — skipping static serving');
  }

  // Health check
  fastify.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.send({ status: 'ok', ts: new Date().toISOString() });
    } catch {
      return reply.status(503).send({ status: 'db_unavailable' });
    }
  });

  // API routes
  await fastify.register(authRoutes);
  await fastify.register(syncRoutes);
  await fastify.register(billingRoutes);

  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`MemCode cloud server running on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
