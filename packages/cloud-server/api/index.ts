import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import serverless from 'serverless-http';
import { buildApp } from '../src/app';

let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

async function getHandler() {
  if (!handler) {
    console.log('[api] init start');
    const app = await buildApp();
    console.log('[api] app built, calling ready()');
    await app.ready();
    console.log('[api] app ready');
    handler = serverless(app);
    console.log('[api] handler created');
  }
  return handler;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  try {
    const h = await getHandler();
    return h(req, res);
  } catch (err) {
    console.error('[api] error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  }
}
