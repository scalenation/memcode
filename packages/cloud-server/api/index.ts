import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import serverless from 'serverless-http';
import { buildApp } from '../src/app';

// Reuse the app instance across warm invocations
let handler: ReturnType<typeof serverless> | null = null;

async function getHandler() {
  if (!handler) {
    const app = await buildApp();
    await app.ready();
    handler = serverless(app);
  }
  return handler;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  const h = await getHandler();
  return h(req, res);
}
