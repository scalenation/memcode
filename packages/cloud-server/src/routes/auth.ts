import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { hash, compare } from 'bcryptjs';
import { pool } from '../db/client';
import { signToken, authenticate } from '../middleware/authenticate';
import type { TokenPayload } from '../middleware/authenticate';

interface RegisterBody {
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/register
   * Body: { email, password }
   * Returns: { token, userId, email }
   */
  fastify.post<{ Body: RegisterBody }>(
    '/v1/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
      const { email, password } = request.body;

      if (!EMAIL_RE.test(email)) {
        return reply.status(400).send({ error: 'Invalid email address' });
      }

      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [
        email.toLowerCase(),
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        return reply.status(409).send({ error: 'Email already registered' });
      }

      const passwordHash = await hash(password, 12);
      const result = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [email.toLowerCase(), passwordHash],
      );

      const userId = result.rows[0].id as string;
      let regSid: string | undefined;
      try {
        const sessionRes = await pool.query(
          'INSERT INTO sessions (user_id, ip, user_agent) VALUES ($1, $2, $3) RETURNING id',
          [userId, request.ip ?? null, (request.headers['user-agent'] as string) ?? null],
        );
        regSid = (sessionRes.rows[0] as { id: string }).id;
      } catch { /* sessions table may not exist yet */ }
      const token = await signToken({ sub: userId, email: email.toLowerCase(), sid: regSid });
      return reply.status(201).send({ token, userId, email: email.toLowerCase() });
    },
  );

  /**
   * POST /v1/auth/login
   * Body: { email, password }
   * Returns: { token, userId, email }
   */
  fastify.post<{ Body: LoginBody }>(
    '/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
      const { email, password } = request.body;

      const result = await pool.query(
        'SELECT id, password_hash FROM users WHERE email = $1',
        [email.toLowerCase()],
      );
      const user = result.rows[0] as
        | { id: string; password_hash: string }
        | undefined;

      if (!user) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      // Accounts created via OAuth or checkout can't use password login until a password is set
      if (user.password_hash === '!LOCKED' || user.password_hash === '!OAUTH') {
        return reply.status(401).send({ error: 'This account was created via Google/GitHub sign-in or checkout. Please sign in with the SSO button above, or reset your password.' });
      }

      const valid = await compare(password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      let loginSid: string | undefined;
      try {
        const sessionRes = await pool.query(
          'INSERT INTO sessions (user_id, ip, user_agent) VALUES ($1, $2, $3) RETURNING id',
          [user.id, request.ip ?? null, (request.headers['user-agent'] as string) ?? null],
        );
        loginSid = (sessionRes.rows[0] as { id: string }).id;
      } catch { /* sessions table may not exist yet */ }
      const token = await signToken({ sub: user.id, email: email.toLowerCase(), sid: loginSid });
      return reply.send({ token, userId: user.id, email: email.toLowerCase() });
    },
  );

  /**
   * GET /v1/auth/me
   * Returns: { userId, email }
   */
  fastify.get(
    '/v1/auth/me',
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user: TokenPayload }).user;
      return reply.send({ userId: user.sub, email: user.email });
    },
  );
}
