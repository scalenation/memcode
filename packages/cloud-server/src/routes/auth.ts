import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { hash, compare } from 'bcryptjs';
import { randomBytes } from 'crypto';
import { pool } from '../db/client';
import { signToken, authenticate } from '../middleware/authenticate';
import type { TokenPayload } from '../middleware/authenticate';
import { config } from '../config';

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
        return reply.status(404).send({ error: 'No account found with that email address.' });
      }

      // Accounts created via OAuth or checkout can't use password login until a password is set
      if (user.password_hash === '!LOCKED' || user.password_hash === '!OAUTH') {
        return reply.status(403).send({ error: 'This account was created via Google/GitHub sign-in or checkout. Use the web dashboard to set a password first.' });
      }

      const valid = await compare(password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({ error: 'Incorrect password.' });
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

  /**
   * POST /v1/auth/set-password
   * For accounts created via OAuth/checkout that don't yet have a CLI password.
   * Body: { email, newPassword }  — no current password required (account is !LOCKED)
   * Returns: { ok: true }
   * Note: requires a valid JWT (user must be signed in via OAuth on the dashboard).
   */
  fastify.post<{ Body: { email: string; newPassword: string } }>(
    '/v1/auth/set-password',
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Body: { email: string; newPassword: string } }>, reply: FastifyReply) => {
      const user = (request as FastifyRequest<{ Body: { email: string; newPassword: string } }> & { user: TokenPayload }).user;
      const { newPassword } = request.body;

      if (!newPassword || newPassword.length < 8) {
        return reply.status(400).send({ error: 'Password must be at least 8 characters.' });
      }

      const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.sub]);
      const row = r.rows[0] as { password_hash: string } | undefined;
      if (!row) return reply.status(404).send({ error: 'User not found' });

      // Only allow setting a password when the account is locked (no existing password)
      if (row.password_hash !== '!LOCKED' && row.password_hash !== '!OAUTH') {
        return reply.status(400).send({ error: 'Account already has a password. Use the change password form instead.' });
      }

      const newHash = await hash(newPassword, 12);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.sub]);
      return reply.send({ ok: true });
    },
  );

  // ── Magic link ──────────────────────────────────────────────────────────────

  /**
   * POST /v1/auth/magic-link
   * Body: { email }
   * Sends a one-time login link to the user's email.
   * Returns 200 regardless (to avoid email enumeration) but only sends if account exists.
   */
  fastify.post<{ Body: { email: string } }>(
    '/v1/auth/magic-link',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { email: string } }>, reply: FastifyReply) => {
      if (!config.resendApiKey) {
        return reply.status(503).send({ error: 'Email login is not configured on this server.' });
      }

      const email = (request.body.email ?? '').toLowerCase().trim();
      if (!email) return reply.status(400).send({ error: 'Email is required.' });

      const r = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      // Always return 200 to avoid enumeration — just don't send email if no account
      if ((r.rowCount ?? 0) === 0) {
        return reply.send({ ok: true });
      }
      const userId = (r.rows[0] as { id: string }).id;

      const token = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
      await pool.query(
        'INSERT INTO magic_link_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [userId, token, expiresAt],
      );

      const link = `${config.appUrl}/v1/auth/magic-link/verify?token=${token}`;
      const html = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px">🧠 MemCode — sign in link</h2>
          <p style="color:#666;margin:0 0 24px">Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
          <a href="${link}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">Sign in to MemCode →</a>
          <p style="color:#999;font-size:0.82rem;margin-top:24px">If you didn't request this, you can safely ignore it.<br>Link: ${link}</p>
        </div>`;

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.resendFromEmail,
          to: email,
          subject: 'Sign in to MemCode',
          html,
        }),
      });

      if (!emailRes.ok) {
        fastify.log.error({ status: emailRes.status }, 'Resend email failed');
        return reply.status(500).send({ error: 'Failed to send email. Please try again.' });
      }

      return reply.send({ ok: true });
    },
  );

  /**
   * GET /v1/auth/magic-link/verify?token=<hex>
   * Validates the token, issues a JWT, redirects to /dashboard?mc_token=<jwt>
   */
  fastify.get<{ Querystring: { token?: string } }>(
    '/v1/auth/magic-link/verify',
    async (request: FastifyRequest<{ Querystring: { token?: string } }>, reply: FastifyReply) => {
      const { token } = request.query;
      if (!token) {
        return reply.status(400).send({ error: 'Missing token.' });
      }

      const r = await pool.query(
        `SELECT mlt.id, mlt.user_id, mlt.expires_at, mlt.used, u.email
         FROM magic_link_tokens mlt
         JOIN users u ON u.id = mlt.user_id
         WHERE mlt.token = $1`,
        [token],
      );
      if ((r.rowCount ?? 0) === 0) {
        return reply.redirect(`${config.appUrl}/login?error=invalid_magic_link`);
      }
      const row = r.rows[0] as { id: string; user_id: string; expires_at: string; used: boolean; email: string };
      if (row.used || new Date(row.expires_at) < new Date()) {
        return reply.redirect(`${config.appUrl}/login?error=expired_magic_link`);
      }

      // Mark as used
      await pool.query('UPDATE magic_link_tokens SET used = TRUE WHERE id = $1', [row.id]);

      const jwt = await signToken({ sub: row.user_id, email: row.email });
      return reply.redirect(`${config.appUrl}/dashboard?token=${jwt}`);
    },
  );
}
