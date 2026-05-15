import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError, signToken } from './auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleRegister(request, env, db, readJson, json) {
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email)) {
    throw new HttpError(400, { error: 'Invalid email address' });
  }
  if (password.length < 8) {
    throw new HttpError(400, { error: 'Password must be at least 8 characters.' });
  }

  const existing = await db.first('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing) {
    throw new HttpError(409, { error: 'Email already registered' });
  }

  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.run(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, email, passwordHash, Date.now()],
  );

  const sessionId = await createSession(db, userId, request);
  const token = await signToken({ sub: userId, email, sid: sessionId }, env);
  return json({ token, userId, email }, { status: 201 });
}

export async function handleLogin(request, env, db, readJson, json) {
  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const user = await db.first('SELECT id, password_hash FROM users WHERE email = ? LIMIT 1', [email]);
  if (!user) {
    throw new HttpError(404, { error: 'No account found with that email address.' });
  }

  if (user.password_hash === '!LOCKED' || user.password_hash === '!OAUTH') {
    throw new HttpError(403, { error: 'This account was created via Google/GitHub sign-in or checkout. Use the web dashboard to set a password first.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new HttpError(401, { error: 'Incorrect password.' });
  }

  const sessionId = await createSession(db, user.id, request);
  const token = await signToken({ sub: user.id, email, sid: sessionId }, env);
  return json({ token, userId: user.id, email });
}

export async function handleSetPassword(request, env, db, readJson, json, user) {
  const body = await readJson(request);
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (newPassword.length < 8) {
    throw new HttpError(400, { error: 'Password must be at least 8 characters.' });
  }

  const row = await db.first('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [user.sub]);
  if (!row) {
    throw new HttpError(404, { error: 'User not found' });
  }
  if (row.password_hash !== '!LOCKED' && row.password_hash !== '!OAUTH') {
    throw new HttpError(400, { error: 'Account already has a password. Use the change password form instead.' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.sub]);
  return json({ ok: true });
}

export async function handleMagicLink(request, env, db, readJson, json) {
  if (!env.RESEND_API_KEY) {
    throw new HttpError(503, { error: 'Email login is not configured on this server.' });
  }

  const body = await readJson(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) {
    throw new HttpError(400, { error: 'Email is required.' });
  }

  const user = await db.first('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (!user) {
    return json({ ok: true });
  }

  const token = randomHex(32);
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await db.run(
    'INSERT INTO magic_link_tokens (id, user_id, token, expires_at, used) VALUES (?, ?, ?, ?, 0)',
    [crypto.randomUUID(), user.id, token, expiresAt],
  );

  const appUrl = getAppUrl(env, request);
  const link = `${appUrl}/v1/auth/magic-link/verify?token=${token}`;
  const html = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px">MemCode sign in link</h2>
          <p style="color:#666;margin:0 0 24px">Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
          <a href="${link}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">Sign in to MemCode</a>
          <p style="color:#999;font-size:0.82rem;margin-top:24px">If you didn't request this, you can safely ignore it.<br>Link: ${link}</p>
        </div>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL ?? 'MemCode <noreply@memcode.pro>',
      to: email,
      subject: 'Sign in to MemCode',
      html,
    }),
  });

  if (!response.ok) {
    const resendErr = await response.json().catch(() => ({}));
    const message = typeof resendErr.message === 'string' ? resendErr.message : JSON.stringify(resendErr);
    throw new HttpError(500, { error: `Email send failed: ${message}` });
  }

  return json({ ok: true });
}

export async function handleMagicLinkVerify(request, env, db) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const appUrl = getAppUrl(env, request);

  if (!token) {
    throw new HttpError(400, { error: 'Missing token.' });
  }

  const row = await db.first(
    `SELECT mlt.id, mlt.user_id, mlt.expires_at, mlt.used, u.email
     FROM magic_link_tokens mlt
     JOIN users u ON u.id = mlt.user_id
     WHERE mlt.token = ?
     LIMIT 1`,
    [token],
  );

  if (!row) {
    return redirect(`${appUrl}/login?error=invalid_magic_link`);
  }
  if (Number(row.used ?? 0) !== 0 || Number(row.expires_at) < Date.now()) {
    return redirect(`${appUrl}/login?error=expired_magic_link`);
  }

  await db.run('UPDATE magic_link_tokens SET used = 1 WHERE id = ?', [row.id]);
  const sessionId = await createSession(db, row.user_id, request);
  const jwt = await signToken({ sub: row.user_id, email: row.email, sid: sessionId }, env);
  return redirect(`${appUrl}/dashboard?token=${encodeURIComponent(jwt)}`);
}

export async function handleGoogleStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirect(`${getAppUrl(env, request)}/login.html?error=not_configured`);
  }

  const state = await signState(env);
  const appUrl = getAppUrl(env, request);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${appUrl}/v1/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

export async function handleGoogleCallback(request, env, db) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirect(`${getAppUrl(env, request)}/login.html?error=not_configured`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const appUrl = getAppUrl(env, request);
  if (error || !code || !state) {
    return redirect(`${appUrl}/login.html?error=oauth_denied`);
  }

  try {
    await verifyState(state, env);
  } catch {
    return redirect(`${appUrl}/login.html?error=invalid_state`);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${appUrl}/v1/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return redirect(`${appUrl}/login.html?error=token_exchange`);
  }

  const tokens = await tokenRes.json();
  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) {
    return redirect(`${appUrl}/login.html?error=userinfo`);
  }

  const googleUser = await userRes.json();
  try {
    const user = await findOrCreateOAuthUser(db, googleUser.email, 'google', googleUser.sub);
    const sessionId = await createSession(db, user.id, request);
    const jwt = await signToken({ sub: user.id, email: user.email, sid: sessionId }, env);
    return redirect(`${appUrl}/dashboard.html?token=${encodeURIComponent(jwt)}`);
  } catch {
    return redirect(`${appUrl}/login.html?error=server_error`);
  }
}

export async function handleGithubStart(request, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return redirect(`${getAppUrl(env, request)}/login.html?error=not_configured`);
  }

  const state = await signState(env);
  const appUrl = getAppUrl(env, request);
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${appUrl}/v1/auth/github/callback`,
    scope: 'read:user user:email',
    state,
  });
  return redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
}

export async function handleGithubCallback(request, env, db) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return redirect(`${getAppUrl(env, request)}/login.html?error=not_configured`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const appUrl = getAppUrl(env, request);
  if (error || !code || !state) {
    return redirect(`${appUrl}/login.html?error=oauth_denied`);
  }

  try {
    await verifyState(state, env);
  } catch {
    return redirect(`${appUrl}/login.html?error=invalid_state`);
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: `${appUrl}/v1/auth/github/callback`,
    }),
  });
  if (!tokenRes.ok) {
    return redirect(`${appUrl}/login.html?error=token_exchange`);
  }

  const tokens = await tokenRes.json();
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'User-Agent': 'MemCode',
    },
  });
  if (!userRes.ok) {
    return redirect(`${appUrl}/login.html?error=userinfo`);
  }

  const githubUser = await userRes.json();
  let email = githubUser.email;
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'User-Agent': 'MemCode',
      },
    });
    if (emailRes.ok) {
      const emails = await emailRes.json();
      email = emails.find((entry) => entry.primary && entry.verified)?.email ?? emails[0]?.email ?? null;
    }
  }
  if (!email) {
    return redirect(`${appUrl}/login.html?error=no_email`);
  }

  try {
    const user = await findOrCreateOAuthUser(db, email, 'github', String(githubUser.id));
    const sessionId = await createSession(db, user.id, request);
    const jwt = await signToken({ sub: user.id, email: user.email, sid: sessionId }, env);
    return redirect(`${appUrl}/dashboard.html?token=${encodeURIComponent(jwt)}`);
  } catch {
    return redirect(`${appUrl}/login.html?error=server_error`);
  }
}

async function signState(env) {
  return new SignJWT({ purpose: 'oauth_state' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(env.JWT_SECRET));
}

async function verifyState(state, env) {
  const { payload } = await jwtVerify(state, new TextEncoder().encode(env.JWT_SECRET));
  if (payload.purpose !== 'oauth_state') {
    throw new Error('invalid state');
  }
}

async function findOrCreateOAuthUser(db, email, provider, sub) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const byOAuth = await db.first(
    'SELECT id, email FROM users WHERE oauth_provider = ? AND oauth_sub = ? LIMIT 1',
    [provider, sub],
  );
  if (byOAuth) {
    return byOAuth;
  }

  const byEmail = await db.first('SELECT id, email FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
  if (byEmail) {
    await db.run('UPDATE users SET oauth_provider = ?, oauth_sub = ? WHERE id = ?', [provider, sub, byEmail.id]);
    return byEmail;
  }

  const user = {
    id: crypto.randomUUID(),
    email: normalizedEmail,
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, oauth_provider, oauth_sub, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, '!OAUTH', provider, sub, Date.now()],
  );
  return user;
}

async function createSession(db, userId, request) {
  try {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    await db.run(
      `INSERT INTO sessions (id, user_id, ip, user_agent, created_at, last_seen_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        sessionId,
        userId,
        request.headers.get('cf-connecting-ip') ?? null,
        request.headers.get('user-agent') ?? null,
        now,
        now,
      ],
    );
    return sessionId;
  } catch {
    return undefined;
  }
}

function getAppUrl(env, request) {
  const value = typeof env.APP_URL === 'string' && env.APP_URL.trim()
    ? env.APP_URL.trim()
    : new URL(request.url).origin;
  return value.replace(/\/$/, '');
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function redirect(location) {
  return Response.redirect(location, 302);
}