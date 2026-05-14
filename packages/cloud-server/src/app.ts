import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';
import { pool } from './db/client';
import { neon } from '@neondatabase/serverless';
import { authRoutes } from './routes/auth';
import { syncRoutes } from './routes/sync';
import { billingRoutes } from './routes/billing';
import { oauthRoutes } from './routes/oauth';
import { userRoutes } from './routes/user';
import { brainRoutes } from './routes/brain';

export async function buildApp(): Promise<FastifyInstance> {
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
        const str = (body as Buffer).toString();
        const parsed = str.length > 0 ? JSON.parse(str) as unknown : {};
        Object.assign(_req, { rawBody: body });
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // CORS — allow CLI and browser requests
  await fastify.register(cors, {
    origin: [config.appUrl, 'https://memcode.pro', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Serve landing page static files (standalone server only)
  if (process.env.SERVE_STATIC !== 'false') {
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
  }

  // Root info
  fastify.get('/', async (_req, reply) => {
    return reply.send({ name: 'MemCode Cloud API', version: '1.0.0', status: 'ok' });
  });

  // One-time migration endpoint — protected by a secret
  fastify.post('/v1/admin/migrate', async (_req, reply) => {
    if (_req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const sql = neon(config.databaseUrl);
    const schemaPath = join(__dirname, 'db', 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    const stmts = schema.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of stmts) {
      await sql.query(stmt, []);
    }
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    return reply.send({ ok: true, stmts: stmts.length, tables });
  });

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
  await fastify.register(oauthRoutes);
  await fastify.register(userRoutes);
  await fastify.register(brainRoutes);

  // Run incremental schema migrations on every cold start (all statements are idempotent)
  fastify.addHook('onReady', async () => {
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_sub TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_oauth_idx ON users(oauth_provider, oauth_sub) WHERE oauth_provider IS NOT NULL`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked BOOLEAN NOT NULL DEFAULT FALSE
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS magic_link_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE
      )`,
      `CREATE INDEX IF NOT EXISTS magic_link_tokens_token_idx ON magic_link_tokens(token)`,
      // Session history metadata
      `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS name TEXT`,
      `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS machine_name TEXT`,
      `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS ip TEXT`,
      `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS user_agent TEXT`,
      `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS label TEXT`,
      `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS meta JSONB`,
      `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS brain JSONB`,
    ];
    for (const sql of migrations) {
      try {
        await pool.query(sql);
      } catch (err) {
        fastify.log.warn({ err, sql }, 'Schema migration warning (non-fatal)');
      }
    }
  });

  return fastify;
}
