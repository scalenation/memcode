import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance | null = null;

async function getApp() {
  if (!app) {
    console.log('[api] building fastify app');
    app = await buildApp();
    await app.ready();
    console.log('[api] fastify app ready');
  }
  return app;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  try {
    const fastify = await getApp();
    fastify.routing(req, res);
  } catch (err) {
    console.error('[api] error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}
