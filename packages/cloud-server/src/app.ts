import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { config } from './config';
import { pool } from './db/client';
import { authRoutes } from './routes/auth';
import { syncRoutes } from './routes/sync';
import { billingRoutes } from './routes/billing';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false,
  });

  // Health check
  fastify.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', ts: new Date().toISOString() });
  });

  return fastify;
}
