import type { FastifyRequest, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config';
import { pool } from '../db/client';

export interface TokenPayload {
  sub: string;   // userId
  email: string;
  sid?: string;  // session ID — optional, old tokens won't carry this
}

const secret = new TextEncoder().encode(config.jwtSecret);

export async function signToken(payload: TokenPayload): Promise<string> {
  const claims: Record<string, string> = { email: payload.email };
  if (payload.sid) claims.sid = payload.sid;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return {
    sub: payload.sub as string,
    email: payload['email'] as string,
    sid: payload['sid'] as string | undefined,
  };
}

/**
 * Fastify pre-handler hook — attaches `request.user` or sends 401.
 * If the token carries a session ID, also checks that the session hasn't been revoked.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const user = await verifyToken(token);
    if (user.sid) {
      try {
        const r = await pool.query('SELECT revoked FROM sessions WHERE id = $1', [user.sid]);
        if ((r.rowCount ?? 0) > 0 && (r.rows[0] as { revoked: boolean }).revoked) {
          reply.status(401).send({ error: 'Session has been revoked' });
          return;
        }
        // Fire-and-forget last_seen_at update — don't await
        pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [user.sid]).catch(() => {});
      } catch {
        // sessions table may not exist on first deploy — non-fatal
      }
    }
    (request as FastifyRequest & { user: TokenPayload }).user = user;
  } catch {
    reply.status(401).send({ error: 'Invalid or expired token' });
  }
}
