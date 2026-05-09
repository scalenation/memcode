import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import serverless from 'serverless-http';
import { buildApp } from '../src/app';

// Reuse the app instance across warm invocations
let handler: ReturnType<typeof serverless> | null = null;

async function getHandler() {
  if (!handler) {
    console.log('[api] building app...');
    const app = await buildApp();
    console.log('[api] calling app.ready()...');
    await app.ready();
    console.log('[api] wrapping with serverless...');
    handler = serverless(app.server);
    console.log('[api] handler ready');
  }
  return handler;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  const h = await getHandler();
  return h(req, res);
}
