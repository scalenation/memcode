import { jwtVerify } from 'jose';

export class HttpError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function authenticateRequest(request, env, db) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, { error: 'Missing or invalid Authorization header' });
  }
  if (!env.JWT_SECRET) {
    throw new HttpError(500, { error: 'JWT secret is not configured' });
  }

  const token = authHeader.slice(7);
  let payload;
  try {
    const result = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET));
    payload = result.payload;
  } catch {
    throw new HttpError(401, { error: 'Invalid or expired token' });
  }

  const user = {
    sub: payload.sub,
    email: payload.email,
    sid: payload.sid,
  };

  if (!user.sub || !user.email) {
    throw new HttpError(401, { error: 'Invalid or expired token' });
  }

  if (user.sid) {
    try {
      const session = await db.first(
        'SELECT revoked FROM sessions WHERE id = ? LIMIT 1',
        [user.sid],
      );
      if (session && Number(session.revoked ?? 0) !== 0) {
        throw new HttpError(401, { error: 'Session has been revoked' });
      }
      await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [Date.now(), user.sid]);
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
  }

  return user;
}

export async function requireActiveSubscription(userId, db) {
  const subscription = await db.first(
    `SELECT id
     FROM subscriptions
     WHERE user_id = ?
       AND status IN ('active', 'trialing')
       AND current_period_end > ?
     LIMIT 1`,
    [userId, Date.now()],
  );

  if (!subscription) {
    throw new HttpError(402, {
      error: 'Pro subscription required',
      upgradeUrl: '/pricing',
    });
  }
}