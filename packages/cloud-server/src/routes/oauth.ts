import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { pool } from '../db/client';
import { signToken } from '../middleware/authenticate';
import { config } from '../config';

const secret = new TextEncoder().encode(config.jwtSecret);

/** Short-lived JWT used as CSRF state in OAuth redirects */
async function signState(): Promise<string> {
  return new SignJWT({ purpose: 'oauth_state' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secret);
}

async function verifyState(state: string): Promise<void> {
  const { payload } = await jwtVerify(state, secret);
  if (payload.purpose !== 'oauth_state') throw new Error('invalid state');
}

/**
 * Find user by OAuth identity, or by email (to link), or create a new user.
 */
async function findOrCreateOAuthUser(
  email: string,
  provider: string,
  sub: string,
): Promise<{ id: string; email: string }> {
  // 1. Exact OAuth identity match
  const byOAuth = await pool.query(
    'SELECT id, email FROM users WHERE oauth_provider = $1 AND oauth_sub = $2',
    [provider, sub],
  );
  if ((byOAuth.rowCount ?? 0) > 0) {
    return byOAuth.rows[0] as { id: string; email: string };
  }

  // 2. Same email — link OAuth to existing account
  const byEmail = await pool.query(
    'SELECT id, email FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  if ((byEmail.rowCount ?? 0) > 0) {
    const user = byEmail.rows[0] as { id: string; email: string };
    await pool.query(
      'UPDATE users SET oauth_provider = $1, oauth_sub = $2 WHERE id = $3',
      [provider, sub, user.id],
    );
    return user;
  }

  // 3. New user
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, oauth_provider, oauth_sub)
     VALUES ($1, '!OAUTH', $2, $3)
     RETURNING id, email`,
    [email.toLowerCase(), provider, sub],
  );
  return result.rows[0] as { id: string; email: string };
}

type OAuthQuery = { Querystring: { code?: string; state?: string; error?: string } };

export async function oauthRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Google ────────────────────────────────────────────────────────────────
  fastify.get('/v1/auth/google', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return reply.redirect(`${config.appUrl}/login.html?error=not_configured`);
    }
    const state = await signState();
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: `${config.appUrl}/v1/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  fastify.get<OAuthQuery>(
    '/v1/auth/google/callback',
    async (request: FastifyRequest<OAuthQuery>, reply: FastifyReply) => {
      if (!config.googleClientId || !config.googleClientSecret) {
        return reply.redirect(`${config.appUrl}/login.html?error=not_configured`);
      }
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        return reply.redirect(`${config.appUrl}/login.html?error=oauth_denied`);
      }
      try { await verifyState(state); } catch {
        return reply.redirect(`${config.appUrl}/login.html?error=invalid_state`);
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
            redirect_uri: `${config.appUrl}/v1/auth/google/callback`,
            grant_type: 'authorization_code',
          }),
        });
        if (!tokenRes.ok) return reply.redirect(`${config.appUrl}/login.html?error=token_exchange`);
        const tokens = await tokenRes.json() as { access_token: string };

        const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (!userRes.ok) return reply.redirect(`${config.appUrl}/login.html?error=userinfo`);
        const googleUser = await userRes.json() as { sub: string; email: string };

        try {
          const user = await findOrCreateOAuthUser(googleUser.email, 'google', googleUser.sub);
          const jwt = await signToken({ sub: user.id, email: user.email });
          return reply.redirect(`${config.appUrl}/dashboard.html?token=${encodeURIComponent(jwt)}`);
        } catch {
          return reply.redirect(`${config.appUrl}/login.html?error=server_error`);
        }
      },
    );

  // ── GitHub ────────────────────────────────────────────────────────────────
  fastify.get('/v1/auth/github', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!config.githubClientId || !config.githubClientSecret) {
      return reply.redirect(`${config.appUrl}/login.html?error=not_configured`);
    }
    const state = await signState();
    const params = new URLSearchParams({
      client_id: config.githubClientId,
      redirect_uri: `${config.appUrl}/v1/auth/github/callback`,
      scope: 'read:user user:email',
      state,
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  fastify.get<OAuthQuery>(
    '/v1/auth/github/callback',
    async (request: FastifyRequest<OAuthQuery>, reply: FastifyReply) => {
      if (!config.githubClientId || !config.githubClientSecret) {
        return reply.redirect(`${config.appUrl}/login.html?error=not_configured`);
      }
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        return reply.redirect(`${config.appUrl}/login.html?error=oauth_denied`);
      }
      try { await verifyState(state); } catch {
        return reply.redirect(`${config.appUrl}/login.html?error=invalid_state`);
      }

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          redirect_uri: `${config.appUrl}/v1/auth/github/callback`,
        }),
      });
      if (!tokenRes.ok) return reply.redirect(`${config.appUrl}/login.html?error=token_exchange`);
      const tokens = await tokenRes.json() as { access_token: string };

      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'MemCode' },
      });
      if (!userRes.ok) return reply.redirect(`${config.appUrl}/login.html?error=userinfo`);
      const ghUser = await userRes.json() as { id: number; email: string | null };

      let email = ghUser.email;
      if (!email) {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'MemCode' },
        });
        if (emailRes.ok) {
          const emails = await emailRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
          email = emails.find(e => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
        }
      }
      if (!email) return reply.redirect(`${config.appUrl}/login.html?error=no_email`);

      try {
        const user = await findOrCreateOAuthUser(email, 'github', String(ghUser.id));
        const jwt = await signToken({ sub: user.id, email: user.email });
        return reply.redirect(`${config.appUrl}/dashboard.html?token=${encodeURIComponent(jwt)}`);
      } catch {
        return reply.redirect(`${config.appUrl}/login.html?error=server_error`);
      }
    },
  );
}
