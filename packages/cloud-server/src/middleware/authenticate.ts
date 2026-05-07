import type { FastifyRequest, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config';

export interface TokenPayload {
  sub: string;   // userId
  email: string;
}

const secret = new TextEncoder().encode(config.jwtSecret);

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secret);
  return { sub: payload.sub as string, email: payload['email'] as string };
}

/**
 * Fastify pre-handler hook — attaches `request.user` or sends 401.
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
    (request as FastifyRequest & { user: TokenPayload }).user = user;
  } catch {
    reply.status(401).send({ error: 'Invalid or expired token' });
  }
}
