import type { IncomingMessage, ServerResponse } from 'node:http';

export default function (req: IncomingMessage, res: ServerResponse) {
  console.log('[api] minimal handler hit');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
}
