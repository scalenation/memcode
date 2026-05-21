import bcrypt from 'bcryptjs';
import { createD1Client } from './cloudflare/d1.js';
import {
  defaultSyncBlobKey,
  deleteWorkspacePayloads,
  loadSyncPayload,
  storeSyncPayload,
} from './cloudflare/blob-storage.js';
import { HttpError, authenticateRequest, requireActiveSubscription, signToken } from './cloudflare/auth.js';
import {
  buildAvailableOpenRouterModels,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_MODELS,
  decryptSecret,
  fetchOpenRouterKeyInfo,
  fetchOpenRouterModels,
  encryptSecret,
  isSupportedOpenRouterModel,
} from './cloudflare/openrouter.js';
import {
  compactLatestBrainRows,
  generateBrainAnswer,
  generateBrainReport,
  loadAiDashboardUsage,
  latestBrainRow,
  latestProjectBrainRow,
  listProjectGroups,
} from './cloudflare/brain.js';
import {
  cancelStripeSubscription,
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  createStripeCustomer,
  createStripeSetupIntent,
  createStripeSubscription,
  detachStripePaymentMethod,
  listStripePaymentMethods,
  listStripeSubscriptions,
  retrieveStripeCustomer,
  retrieveStripePaymentMethod,
  updateStripeCustomer,
  updateStripeSubscription,
  verifyStripeWebhook,
} from './cloudflare/stripe.js';
import {
  handleGithubCallback,
  handleGithubStart,
  handleGoogleCallback,
  handleGoogleStart,
  handleLogin,
  handleMagicLink,
  handleMagicLinkVerify,
  handleRegister,
  handleSetPassword,
} from './cloudflare/web-auth.js';

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'memcode.pro') {
      const redirectUrl = new URL(request.url);
      redirectUrl.hostname = 'www.memcode.pro';
      return Response.redirect(redirectUrl.toString(), 301);
    }

    const db = createD1Client(env.DB);
    const workspaceDeleteMatch = matchPath(url.pathname, /^\/v1\/user\/workspaces\/([^/]+)$/);
    const sessionDeleteMatch = matchPath(url.pathname, /^\/v1\/user\/sessions\/([^/]+)$/);
    const brainProjectAskMatch = matchPath(url.pathname, /^\/v1\/brain\/projects\/([^/]+)\/ask$/);
    const brainProjectReportMatch = matchPath(url.pathname, /^\/v1\/brain\/projects\/([^/]+)\/report$/);
    const brainProjectMatch = matchPath(url.pathname, /^\/v1\/brain\/projects\/([^/]+)$/);
    const brainWorkspaceAskMatch = matchPath(url.pathname, /^\/v1\/brain\/workspaces\/([^/]+)\/ask$/);
    const brainWorkspaceReportMatch = matchPath(url.pathname, /^\/v1\/brain\/workspaces\/([^/]+)\/report$/);
    const brainWorkspaceMatch = matchPath(url.pathname, /^\/v1\/brain\/workspaces\/([^/]+)$/);
    const billingPaymentMethodMatch = matchPath(url.pathname, /^\/v1\/billing\/payment-method\/([^/]+)$/);

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        if (env.ASSETS) {
          return env.ASSETS.fetch(request);
        }
        return json({ name: 'MemCode Cloud API', runtime: 'cloudflare-worker', status: 'ok' });
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        await db.first('SELECT 1 AS ok');
        return json({
          status: 'ok',
          runtime: 'cloudflare-worker',
          appUrl: env.APP_URL ?? null,
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/auth/register') {
        return handleRegister(request, env, db, readJson, json);
      }

      if (request.method === 'POST' && url.pathname === '/v1/auth/login') {
        return handleLogin(request, env, db, readJson, json);
      }

      if (request.method === 'POST' && url.pathname === '/v1/auth/set-password') {
        const user = await authenticateRequest(request, env, db);
        return handleSetPassword(request, env, db, readJson, json, user);
      }

      if (request.method === 'POST' && url.pathname === '/v1/auth/magic-link') {
        return handleMagicLink(request, env, db, readJson, json);
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/magic-link/verify') {
        return handleMagicLinkVerify(request, env, db);
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/google') {
        return handleGoogleStart(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/google/callback') {
        return handleGoogleCallback(request, env, db);
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/github') {
        return handleGithubStart(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/github/callback') {
        return handleGithubCallback(request, env, db);
      }

      if (request.method === 'GET' && url.pathname === '/v1/auth/me') {
        const user = await authenticateRequest(request, env, db);
        return json({ userId: user.sub, email: user.email });
      }

      if (request.method === 'GET' && url.pathname === '/v1/user/profile') {
        const user = await authenticateRequest(request, env, db);
        const userRow = await db.first(
          `SELECT name, password_hash, openrouter_api_key_encrypted, openrouter_model
           FROM users
           WHERE id = ?
           LIMIT 1`,
          [user.sub],
        );
        const subscriptionRow = await db.first(
          `SELECT status, stripe_price_id, current_period_end
           FROM subscriptions
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [user.sub],
        );

        let aiAvailability = null;
        let availableModels = OPENROUTER_MODELS;
        if (userRow?.openrouter_api_key_encrypted) {
          try {
            const apiKey = await decryptSecret(userRow.openrouter_api_key_encrypted, env);
            aiAvailability = await fetchOpenRouterKeyInfo(env, apiKey);
            availableModels = await fetchOpenRouterModels(env, apiKey);
          } catch {
            aiAvailability = null;
            availableModels = buildAvailableOpenRouterModels();
          }
        }

        return json({
          userId: user.sub,
          email: user.email,
          name: userRow?.name ?? null,
          subscription: subscriptionRow ? {
            status: subscriptionRow.status,
            planName: subscriptionRow.stripe_price_id === env.STRIPE_PRICE_ID_YEARLY ? 'Pro Yearly' : 'Pro Monthly',
            currentPeriodEnd: toIsoString(subscriptionRow.current_period_end),
          } : null,
          hasPassword: !!userRow && userRow.password_hash !== '!LOCKED' && userRow.password_hash !== '!OAUTH',
          aiSettings: {
            hasOpenRouterKey: Boolean(userRow?.openrouter_api_key_encrypted),
            openRouterModel: userRow?.openrouter_model ?? DEFAULT_OPENROUTER_MODEL,
            availableModels,
            availability: aiAvailability,
          },
          integrations: {
            googleClientId: env.GOOGLE_CLIENT_ID ?? null,
          },
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/user/ai-usage') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const projectId = url.searchParams.get('projectId')?.trim() || null;
        return json(await loadAiDashboardUsage(db, env, user.sub, projectId));
      }

      if (request.method === 'PUT' && url.pathname === '/v1/user/profile') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);

        if (body.name !== undefined) {
          const trimmed = String(body.name ?? '').trim().slice(0, 128);
          await db.run('UPDATE users SET name = ? WHERE id = ?', [trimmed || null, user.sub]);
        }

        if (body.currentPassword !== undefined || body.newPassword !== undefined) {
          if (!body.currentPassword || !body.newPassword) {
            throw new HttpError(400, { error: 'Both currentPassword and newPassword are required.' });
          }
          if (String(body.newPassword).length < 8) {
            throw new HttpError(400, { error: 'New password must be at least 8 characters.' });
          }
          const row = await db.first('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [user.sub]);
          if (!row || row.password_hash === '!LOCKED' || row.password_hash === '!OAUTH') {
            throw new HttpError(400, { error: 'Password change is not available for SSO accounts.' });
          }
          const valid = await bcrypt.compare(String(body.currentPassword), row.password_hash);
          if (!valid) {
            throw new HttpError(401, { error: 'Current password is incorrect.' });
          }
          const newHash = await bcrypt.hash(String(body.newPassword), 12);
          await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.sub]);
        }

        return json({ ok: true });
      }

      if (request.method === 'PUT' && url.pathname === '/v1/user/ai-settings') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const openRouterApiKey = typeof body.openRouterApiKey === 'string' ? body.openRouterApiKey.trim() : '';
        const openRouterModel = typeof body.openRouterModel === 'string' && body.openRouterModel.trim()
          ? body.openRouterModel.trim()
          : DEFAULT_OPENROUTER_MODEL;
        const clearOpenRouterKey = Boolean(body.clearOpenRouterKey);
        let availableModels = buildAvailableOpenRouterModels();

        let availability = null;
        if (openRouterApiKey) {
          try {
            availability = await fetchOpenRouterKeyInfo(env, openRouterApiKey);
            availableModels = await fetchOpenRouterModels(env, openRouterApiKey);
          } catch (error) {
            throw new HttpError(400, { error: error?.message ?? 'OpenRouter key validation failed.' });
          }
        } else if (!clearOpenRouterKey) {
          const existingRow = await db.first(
            'SELECT openrouter_api_key_encrypted FROM users WHERE id = ? LIMIT 1',
            [user.sub],
          );
          if (existingRow?.openrouter_api_key_encrypted) {
            try {
              const savedApiKey = await decryptSecret(existingRow.openrouter_api_key_encrypted, env);
              availableModels = await fetchOpenRouterModels(env, savedApiKey);
            } catch {
              availableModels = buildAvailableOpenRouterModels();
            }
          }
        }

        if (!isSupportedOpenRouterModel(openRouterModel, availableModels)) {
          throw new HttpError(400, { error: 'Unsupported OpenRouter model selection.' });
        }

        const encryptedKey = openRouterApiKey ? await encryptSecret(openRouterApiKey, env) : null;
        if (clearOpenRouterKey && !encryptedKey) {
          await db.run(
            'UPDATE users SET openrouter_api_key_encrypted = NULL, openrouter_model = ? WHERE id = ?',
            [openRouterModel, user.sub],
          );
        } else {
          await db.run(
            `UPDATE users
             SET openrouter_api_key_encrypted = COALESCE(?, openrouter_api_key_encrypted),
                 openrouter_model = ?
             WHERE id = ?`,
            [encryptedKey, openRouterModel, user.sub],
          );
        }

        const row = await db.first(
          'SELECT openrouter_api_key_encrypted, openrouter_model FROM users WHERE id = ? LIMIT 1',
          [user.sub],
        );
        if (!availability && row?.openrouter_api_key_encrypted) {
          try {
            const savedApiKey = await decryptSecret(row.openrouter_api_key_encrypted, env);
            availability = await fetchOpenRouterKeyInfo(env, savedApiKey);
            availableModels = await fetchOpenRouterModels(env, savedApiKey);
          } catch {
            availability = null;
            availableModels = buildAvailableOpenRouterModels();
          }
        }
        return json({
          ok: true,
          aiSettings: {
            hasOpenRouterKey: Boolean(row?.openrouter_api_key_encrypted),
            openRouterModel: row?.openrouter_model ?? DEFAULT_OPENROUTER_MODEL,
            availableModels,
            availability,
          },
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/user/workspaces') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);

        const result = await db.all(
          `SELECT
             w.id,
             w.name,
             w.machine_name,
             w.created_at,
             COUNT(b.id) AS blob_count,
             MAX(b.created_at) AS last_synced_at,
             COALESCE(SUM(COALESCE(b.payload_size, LENGTH(b.payload_encrypted))), 0) AS storage_bytes
           FROM workspaces w
           LEFT JOIN sync_blobs b ON b.workspace_id = w.id
           WHERE w.user_id = ?
           GROUP BY w.id, w.name, w.machine_name, w.created_at
           ORDER BY w.created_at DESC`,
          [user.sub],
        );

        const workspaces = result.rows.map((row) => ({
          id: row.id,
          name: row.name ?? null,
          machineName: row.machine_name ?? null,
          createdAt: toIsoString(row.created_at),
          lastSyncedAt: row.last_synced_at == null ? null : toIsoString(row.last_synced_at),
          blobCount: toNumber(row.blob_count),
          storageBytes: toNumber(row.storage_bytes),
        }));

        return json({
          workspaces,
          totalStorageBytes: workspaces.reduce((sum, item) => sum + item.storageBytes, 0),
          totalBlobCount: workspaces.reduce((sum, item) => sum + item.blobCount, 0),
        });
      }

      if (request.method === 'DELETE' && workspaceDeleteMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const workspaceId = workspaceDeleteMatch[1];
        const workspace = await getOwnedWorkspace(db, workspaceId, user.sub, true);
        if (!workspace) {
          throw new HttpError(404, { error: 'Workspace not found' });
        }
        await deleteWorkspacePayloads(env, db, workspaceId);
        await db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
        return json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/v1/user/sessions') {
        const user = await authenticateRequest(request, env, db);
        const result = await db.all(
          `SELECT id, ip, user_agent, created_at, last_seen_at
           FROM sessions
           WHERE user_id = ? AND revoked = 0
           ORDER BY last_seen_at DESC
           LIMIT 30`,
          [user.sub],
        );
        return json({
          sessions: result.rows.map((row) => ({
            id: row.id,
            ip: row.ip ?? null,
            userAgent: row.user_agent ?? null,
            createdAt: toIsoString(row.created_at),
            lastSeenAt: toIsoString(row.last_seen_at),
            isCurrent: row.id === user.sid,
          })),
        });
      }

      if (request.method === 'DELETE' && sessionDeleteMatch) {
        const user = await authenticateRequest(request, env, db);
        const sessionId = sessionDeleteMatch[1];
        const row = await db.first('SELECT user_id FROM sessions WHERE id = ? LIMIT 1', [sessionId]);
        if (!row) throw new HttpError(404, { error: 'Session not found' });
        if (row.user_id !== user.sub) throw new HttpError(403, { error: 'Forbidden' });
        await db.run('UPDATE sessions SET revoked = 1 WHERE id = ?', [sessionId]);
        return json({ ok: true });
      }

      if (request.method === 'DELETE' && url.pathname === '/v1/user/account') {
        const user = await authenticateRequest(request, env, db);
        const subRow = await db.first(
          `SELECT stripe_subscription_id
           FROM subscriptions
           WHERE user_id = ? AND status IN ('active', 'trialing')
           LIMIT 1`,
          [user.sub],
        );
        if (subRow?.stripe_subscription_id) {
          try {
            await cancelStripeSubscription(env, subRow.stripe_subscription_id);
          } catch {
            // best effort
          }
        }
        await db.run('DELETE FROM users WHERE id = ?', [user.sub]);
        return json({ ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/v1/sync/workspace') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const body = await readJson(request);
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
        const name = typeof body.name === 'string' ? body.name : null;
        const machineName = typeof body.machineName === 'string' ? body.machineName : null;
        if (!workspaceId) throw new HttpError(400, { error: 'workspaceId is required' });

        const existing = await db.first('SELECT user_id FROM workspaces WHERE id = ? LIMIT 1', [workspaceId]);
        if (existing && existing.user_id !== user.sub) {
          throw new HttpError(403, { error: 'Workspace belongs to another account' });
        }

        await db.run(
          `INSERT INTO workspaces (id, user_id, name, machine_name, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = COALESCE(excluded.name, workspaces.name),
             machine_name = COALESCE(excluded.machine_name, workspaces.machine_name)`,
          [workspaceId, user.sub, name, machineName, Date.now()],
        );

        return json({ workspaceId });
      }

      if (request.method === 'POST' && url.pathname === '/v1/sync/push') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const body = await readJson(request);
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
        const payload = typeof body.payload === 'string' ? body.payload : '';
        if (!workspaceId || !payload) {
          throw new HttpError(400, { error: 'workspaceId and payload are required' });
        }

        await ensureWorkspaceOwned(db, workspaceId, user.sub, true);

        // Replace: delete the previous snapshot for this workspace before storing the new one.
        // This keeps exactly 1 blob per workspace — no accumulation.
        await deleteWorkspacePayloads(env, db, workspaceId);
        await db.run('DELETE FROM sync_blobs WHERE workspace_id = ?', [workspaceId]);

        const blobId = crypto.randomUUID();
        const cursor = String(Date.now());
        const storedPayload = await storeSyncPayload(env, { blobId, workspaceId, cursor, payload });
        await db.run(
          `INSERT INTO sync_blobs (
             id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size,
             ip, user_agent, label, meta, brain, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            blobId,
            workspaceId,
            cursor,
            storedPayload.payloadEncrypted,
            storedPayload.payloadStorageKey,
            storedPayload.payloadSize,
            request.headers.get('cf-connecting-ip') ?? null,
            request.headers.get('user-agent') ?? null,
            typeof body.label === 'string' ? body.label : null,
            Array.isArray(body.meta) ? JSON.stringify(body.meta) : null,
            body.brain ? JSON.stringify(body.brain) : null,
            Date.now(),
          ],
        );
        return json({ cursor, blobId });
      }

      if (request.method === 'POST' && url.pathname === '/v1/sync/push-chunk') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const body = await readJson(request);
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
        const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
        const kind = typeof body.kind === 'string' ? body.kind : '';
        const data = typeof body.data === 'string' ? body.data : '';
        const chunkIndex = Number(body.chunkIndex);
        const totalChunks = Number(body.totalChunks);
        if (!workspaceId || !uploadId || !kind || !data) {
          throw new HttpError(400, { error: 'workspaceId, uploadId, kind, and data are required' });
        }
        if (!['payload', 'meta'].includes(kind) || !Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks) {
          throw new HttpError(400, { error: 'Invalid chunk metadata' });
        }

        await ensureWorkspaceOwned(db, workspaceId, user.sub, true);
        await db.run(
          `INSERT INTO sync_upload_chunks (upload_id, workspace_id, kind, chunk_index, total_chunks, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(upload_id, kind, chunk_index) DO UPDATE SET
             data = excluded.data,
             total_chunks = excluded.total_chunks,
             created_at = excluded.created_at`,
          [uploadId, workspaceId, kind, chunkIndex, totalChunks, data, Date.now()],
        );

        return json({ ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/v1/sync/push-finalize') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const body = await readJson(request);
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
        const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
        if (!workspaceId || !uploadId) {
          throw new HttpError(400, { error: 'workspaceId and uploadId are required' });
        }

        await ensureWorkspaceOwned(db, workspaceId, user.sub, true);
        const chunkRows = await db.all(
          `SELECT kind, chunk_index, total_chunks, data
           FROM sync_upload_chunks
           WHERE upload_id = ? AND workspace_id = ?
           ORDER BY kind, chunk_index`,
          [uploadId, workspaceId],
        );

        const payload = assembleChunks(chunkRows.rows, 'payload');
        if (!payload) throw new HttpError(400, { error: 'Incomplete payload chunks' });
        const metaJson = assembleChunks(chunkRows.rows, 'meta');

        // Replace: delete previous snapshot before storing the new one.
        await deleteWorkspacePayloads(env, db, workspaceId);
        await db.run('DELETE FROM sync_blobs WHERE workspace_id = ?', [workspaceId]);

        const blobId = crypto.randomUUID();
        const cursor = String(Date.now());
        const storedPayload = await storeSyncPayload(env, { blobId, workspaceId, cursor, payload });
        await db.run(
          `INSERT INTO sync_blobs (
             id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size,
             ip, user_agent, label, meta, brain, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            blobId,
            workspaceId,
            cursor,
            storedPayload.payloadEncrypted,
            storedPayload.payloadStorageKey,
            storedPayload.payloadSize,
            request.headers.get('cf-connecting-ip') ?? null,
            request.headers.get('user-agent') ?? null,
            typeof body.label === 'string' ? body.label : null,
            metaJson,
            body.brain ? JSON.stringify(body.brain) : null,
            Date.now(),
          ],
        );
        await db.run('DELETE FROM sync_upload_chunks WHERE upload_id = ? AND workspace_id = ?', [uploadId, workspaceId]);
        return json({ cursor, blobId });
      }

      if (request.method === 'GET' && url.pathname === '/v1/sync/status') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) {
          throw new HttpError(400, { error: 'workspaceId query param is required' });
        }

        const workspace = await getOwnedWorkspace(db, workspaceId, user.sub, true);
        if (!workspace) {
          throw new HttpError(404, { error: 'Workspace not found' });
        }

        const latest = await db.first(
          `SELECT cursor, created_at
           FROM sync_blobs
           WHERE workspace_id = ?
           ORDER BY cursor DESC
           LIMIT 1`,
          [workspaceId],
        );
        const totalPushes = await db.value(
          'SELECT COUNT(*) AS count FROM sync_blobs WHERE workspace_id = ?',
          [workspaceId],
        );

        return json({
          workspaceId,
          lastSyncedAt: latest ? toIsoString(latest.created_at) : null,
          cursor: latest?.cursor ?? '0',
          totalPushes: toNumber(totalPushes),
        });
      }

      if (request.method === 'DELETE' && url.pathname === '/v1/sync/blobs') {
        // Purge all stored blobs for a workspace. Used by `memory sync purge`.
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) throw new HttpError(400, { error: 'workspaceId query param is required' });
        const workspace = await getOwnedWorkspace(db, workspaceId, user.sub, true);
        if (!workspace) throw new HttpError(404, { error: 'Workspace not found' });
        await deleteWorkspacePayloads(env, db, workspaceId);
        await db.run('DELETE FROM sync_blobs WHERE workspace_id = ?', [workspaceId]);
        return json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/v1/sync/pull') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const workspaceId = url.searchParams.get('workspaceId');
        const cursor = url.searchParams.get('cursor') ?? '0';
        const beforeCursor = url.searchParams.get('beforeCursor');
        const afterCursor = url.searchParams.get('afterCursor');
        const blobId = url.searchParams.get('blobId');

        if (!workspaceId) {
          throw new HttpError(400, { error: 'workspaceId query param is required' });
        }

        const workspace = await getOwnedWorkspace(db, workspaceId, user.sub, false);
        if (!workspace) {
          return json({ blob: null, cursor });
        }

        let row = null;
        if (blobId) {
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND id = ?
             LIMIT 1`,
            [workspaceId, blobId],
          );
          if (!row) {
            throw new HttpError(404, { error: 'Checkpoint not found' });
          }
        } else if (beforeCursor) {
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND cursor < ?
             ORDER BY cursor DESC
             LIMIT 1`,
            [workspaceId, beforeCursor],
          );
          if (!row) {
            return json({ blob: null, cursor });
          }
        } else if (afterCursor !== null) {
          // Forward iteration (delta sync): get the OLDEST blob strictly after this cursor.
          // This lets clients walk forward through history like git log --forward.
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND cursor > ?
             ORDER BY cursor ASC
             LIMIT 1`,
            [workspaceId, afterCursor],
          );
          if (!row) {
            return json({ blob: null, cursor: afterCursor });
          }
        } else {
          row = await db.first(
            `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size
             FROM sync_blobs
             WHERE workspace_id = ? AND cursor > ?
             ORDER BY cursor DESC
             LIMIT 1`,
            [workspaceId, cursor],
          );
          if (!row) {
            return json({ blob: null, cursor });
          }
        }

        const payload = await loadSyncPayload(env, row);
        if (!payload) {
          throw new HttpError(500, { error: 'Stored sync payload is unavailable' });
        }

        return json({
          blob: { id: row.id, cursor: row.cursor, payload },
          cursor: row.cursor,
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/sync/history') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);

        const workspaces = await db.all(
          `SELECT id, name, machine_name, created_at
           FROM workspaces
           WHERE user_id = ?
           ORDER BY created_at DESC`,
          [user.sub],
        );

        const result = await Promise.all(workspaces.rows.map(async (workspace) => {
          const blobs = await db.all(
            `SELECT id, cursor, created_at, ip, user_agent, label, meta
             FROM sync_blobs
             WHERE workspace_id = ?
             ORDER BY cursor DESC
             LIMIT 20`,
            [workspace.id],
          );

          return {
            id: workspace.id,
            name: workspace.name ?? null,
            machineName: workspace.machine_name ?? null,
            createdAt: toIsoString(workspace.created_at),
            checkpoints: blobs.rows.map((blob) => ({
              id: blob.id,
              cursor: blob.cursor,
              createdAt: toIsoString(blob.created_at),
              ip: blob.ip ?? null,
              userAgent: blob.user_agent ?? null,
              label: blob.label ?? null,
              meta: parseCheckpointMeta(blob.meta),
            })),
          };
        }));

        return json({ workspaces: result });
      }

      if (request.method === 'GET' && url.pathname === '/v1/brain/projects') {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        return json({ projects: await listProjectGroups(db, user.sub) });
      }

      if (request.method === 'GET' && brainProjectMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const row = await latestProjectBrainRow(db, user.sub, brainProjectMatch[1]);
        if (!row) throw new HttpError(404, { error: 'Project brain not found' });
        return json(row);
      }

      if (request.method === 'GET' && brainProjectAskMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const q = url.searchParams.get('q')?.trim();
        if (!q) throw new HttpError(400, { error: 'q query param is required' });
        const row = await latestProjectBrainRow(db, user.sub, brainProjectAskMatch[1]);
        if (!row) throw new HttpError(404, { error: 'Project brain not found' });
        return json(await generateBrainAnswer(env, db, user.sub, row.brain, q, row.projectName, row.projectId));
      }

      if ((request.method === 'GET' || request.method === 'POST') && brainProjectReportMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const body = request.method === 'POST' ? await readJson(request) : null;
        const type = request.method === 'POST' ? (body?.type ?? 'status') : (url.searchParams.get('type') ?? 'status');
        const prompt = request.method === 'POST' ? (typeof body?.prompt === 'string' ? body.prompt : '') : (url.searchParams.get('prompt') ?? '');
        const row = await latestProjectBrainRow(db, user.sub, brainProjectReportMatch[1]);
        if (!row) throw new HttpError(404, { error: 'Project brain not found' });
        return json({
          projectId: row.projectId,
          projectName: row.projectName,
          type,
          generatedAt: new Date().toISOString(),
          markdown: await generateBrainReport(env, db, user.sub, row.brain, type, row.projectName, row.projectId, prompt),
        });
      }

      if (request.method === 'GET' && brainWorkspaceMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const row = await latestBrainRow(db, user.sub, brainWorkspaceMatch[1]);
        if (!row) throw new HttpError(404, { error: 'Project brain not found' });
        return json(row);
      }

      if (request.method === 'GET' && brainWorkspaceAskMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const q = url.searchParams.get('q')?.trim();
        if (!q) throw new HttpError(400, { error: 'q query param is required' });
        const row = await latestBrainRow(db, user.sub, brainWorkspaceAskMatch[1]);
        if (!row) throw new HttpError(404, { error: 'Project brain not found' });
        return json(await generateBrainAnswer(env, db, user.sub, row.brain, q, row.workspaceId));
      }

      if ((request.method === 'GET' || request.method === 'POST') && brainWorkspaceReportMatch) {
        const user = await authenticateRequest(request, env, db);
        await requireActiveSubscription(user.sub, db);
        const body = request.method === 'POST' ? await readJson(request) : null;
        const type = request.method === 'POST' ? (body?.type ?? 'status') : (url.searchParams.get('type') ?? 'status');
        const prompt = request.method === 'POST' ? (typeof body?.prompt === 'string' ? body.prompt : '') : (url.searchParams.get('prompt') ?? '');
        const row = await latestBrainRow(db, user.sub, brainWorkspaceReportMatch[1]);
        if (!row) throw new HttpError(404, { error: 'Project brain not found' });
        return json({
          workspaceId: row.workspaceId,
          type,
          generatedAt: new Date().toISOString(),
          markdown: await generateBrainReport(env, db, user.sub, row.brain, type, row.workspaceId, null, prompt),
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/checkout') {
        const body = await readJson(request);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
        if (!email) throw new HttpError(400, { error: 'email is required' });
        const priceId = plan === 'yearly' ? env.STRIPE_PRICE_ID_YEARLY : env.STRIPE_PRICE_ID;

        let customerId;
        let checkoutDbUserId;
        const existingUser = await db.first('SELECT id, stripe_customer_id FROM users WHERE email = ? LIMIT 1', [email]);
        if (existingUser) {
          checkoutDbUserId = existingUser.id;
          if (existingUser.stripe_customer_id) {
            customerId = existingUser.stripe_customer_id;
          } else {
            const customer = await createStripeCustomer(env, email);
            customerId = customer.id;
            await db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, existingUser.id]);
          }
        } else {
          const customer = await createStripeCustomer(env, email);
          customerId = customer.id;
        }

        try {
          const session = await createStripeCheckoutSession(env, { customer: customerId, priceId });
          return json({ url: session.url });
        } catch (error) {
          if (String(error.message).includes('No such customer')) {
            const customer = await createStripeCustomer(env, email);
            customerId = customer.id;
            if (checkoutDbUserId) {
              await db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, checkoutDbUserId]);
            }
            const session = await createStripeCheckoutSession(env, { customer: customerId, priceId });
            return json({ url: session.url });
          }
          throw error;
        }
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/setup-intent') {
        const body = await readJson(request);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!email) throw new HttpError(400, { error: 'email is required' });

        let customerId;
        let dbUserId;
        const existingUser = await db.first('SELECT id, stripe_customer_id FROM users WHERE email = ? LIMIT 1', [email]);
        if (existingUser) {
          dbUserId = existingUser.id;
          if (existingUser.stripe_customer_id) {
            customerId = existingUser.stripe_customer_id;
          } else {
            const customer = await createStripeCustomer(env, email);
            customerId = customer.id;
            await db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, existingUser.id]);
          }
        } else {
          const customer = await createStripeCustomer(env, email);
          customerId = customer.id;
        }

        try {
          const setupIntent = await createStripeSetupIntent(env, customerId);
          return json({ clientSecret: setupIntent.client_secret, customerId });
        } catch (error) {
          if (String(error.message).includes('No such customer')) {
            const customer = await createStripeCustomer(env, email);
            customerId = customer.id;
            if (dbUserId) {
              await db.run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, dbUserId]);
            }
            const setupIntent = await createStripeSetupIntent(env, customerId);
            return json({ clientSecret: setupIntent.client_secret, customerId });
          }
          throw error;
        }
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/subscribe') {
        const body = await readJson(request);
        const customerId = typeof body.customerId === 'string' ? body.customerId : '';
        const paymentMethodId = typeof body.paymentMethodId === 'string' ? body.paymentMethodId : '';
        const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
        if (!customerId || !paymentMethodId) {
          throw new HttpError(400, { error: 'customerId and paymentMethodId are required' });
        }

        const priceId = plan === 'yearly' ? env.STRIPE_PRICE_ID_YEARLY : env.STRIPE_PRICE_ID;
        const existing = await listStripeSubscriptions(env, { customer: customerId, limit: 5 });
        const live = (existing.data ?? []).find((sub) => ['active', 'trialing', 'incomplete', 'past_due'].includes(sub.status));
        if (live) {
          return json({ subscriptionId: live.id, status: live.status });
        }

        await updateStripeCustomer(env, customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });

        const subscription = await createStripeSubscription(env, {
          customer: customerId,
          priceId,
          paymentMethodId,
          idempotencyKey: `sub-${customerId}-${priceId}`,
        });

        const customer = await retrieveStripeCustomer(env, customerId);
        const email = customer.email?.toLowerCase();
        if (email) {
          await db.run(
            `INSERT INTO users (id, email, password_hash, stripe_customer_id, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id`,
            [crypto.randomUUID(), email, '!LOCKED', customerId, Date.now()],
          );
          await upsertSubscription(db, subscription);
          const userRow = await db.first('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
          if (userRow) {
            const token = await signToken({ sub: userRow.id, email }, env);
            return json({ subscriptionId: subscription.id, status: subscription.status, token });
          }
        }

        return json({ subscriptionId: subscription.id, status: subscription.status });
      }

      if (request.method === 'GET' && url.pathname === '/v1/billing/payment-methods') {
        const user = await authenticateRequest(request, env, db);
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) return json({ paymentMethods: [] });

        const customer = await retrieveStripeCustomer(env, row.stripe_customer_id);
        const defaultPmId = typeof customer.invoice_settings?.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : customer.invoice_settings?.default_payment_method?.id ?? null;
        const paymentMethods = await listStripePaymentMethods(env, row.stripe_customer_id);
        return json({
          paymentMethods: (paymentMethods.data ?? []).map((pm) => ({
            id: pm.id,
            brand: pm.card?.brand ?? 'card',
            last4: pm.card?.last4 ?? '????',
            expMonth: pm.card?.exp_month ?? 0,
            expYear: pm.card?.exp_year ?? 0,
            isDefault: pm.id === defaultPmId,
          })),
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/update-payment') {
        const user = await authenticateRequest(request, env, db);
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) throw new HttpError(404, { error: 'No billing account found' });
        const setupIntent = await createStripeSetupIntent(env, row.stripe_customer_id);
        return json({ clientSecret: setupIntent.client_secret });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/confirm-payment-update') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const paymentMethodId = typeof body.paymentMethodId === 'string' ? body.paymentMethodId : '';
        if (!paymentMethodId) throw new HttpError(400, { error: 'paymentMethodId is required' });
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) throw new HttpError(404, { error: 'No billing account found' });

        await updateStripeCustomer(env, row.stripe_customer_id, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
        const subs = await listStripeSubscriptions(env, { customer: row.stripe_customer_id, limit: 1 });
        if ((subs.data ?? []).length > 0) {
          await updateStripeSubscription(env, subs.data[0].id, { default_payment_method: paymentMethodId });
        }
        return json({ ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/cancel') {
        const user = await authenticateRequest(request, env, db);
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) throw new HttpError(404, { error: 'No billing account found' });
        const subs = await listStripeSubscriptions(env, { customer: row.stripe_customer_id, status: 'active', limit: 1 });
        if ((subs.data ?? []).length === 0) throw new HttpError(404, { error: 'No active subscription found' });
        const cancelled = await updateStripeSubscription(env, subs.data[0].id, { cancel_at_period_end: true });
        await db.run('UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?', ['canceled', Date.now(), cancelled.id]);
        return json({ ok: true, cancelAt: cancelled.cancel_at ? new Date(cancelled.cancel_at * 1000).toISOString() : null });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/set-default-payment') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const paymentMethodId = typeof body.paymentMethodId === 'string' ? body.paymentMethodId : '';
        if (!paymentMethodId) throw new HttpError(400, { error: 'paymentMethodId is required' });
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) throw new HttpError(404, { error: 'No billing account found' });
        const paymentMethod = await retrieveStripePaymentMethod(env, paymentMethodId);
        if (paymentMethod.customer !== row.stripe_customer_id) throw new HttpError(403, { error: 'Forbidden' });
        await updateStripeCustomer(env, row.stripe_customer_id, { invoice_settings: { default_payment_method: paymentMethodId } });
        const subs = await listStripeSubscriptions(env, { customer: row.stripe_customer_id, limit: 1 });
        if ((subs.data ?? []).length > 0) {
          await updateStripeSubscription(env, subs.data[0].id, { default_payment_method: paymentMethodId });
        }
        return json({ ok: true });
      }

      if (request.method === 'DELETE' && billingPaymentMethodMatch) {
        const user = await authenticateRequest(request, env, db);
        const pmId = billingPaymentMethodMatch[1];
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) throw new HttpError(404, { error: 'No billing account found' });
        const paymentMethod = await retrieveStripePaymentMethod(env, pmId);
        if (paymentMethod.customer !== row.stripe_customer_id) throw new HttpError(403, { error: 'Forbidden' });
        await detachStripePaymentMethod(env, pmId);
        return json({ ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/portal') {
        const user = await authenticateRequest(request, env, db);
        const row = await db.first('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [user.sub]);
        if (!row?.stripe_customer_id) throw new HttpError(404, { error: 'No billing account found' });
        const portalSession = await createStripeBillingPortalSession(env, row.stripe_customer_id);
        return json({ url: portalSession.url });
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/webhook') {
        const rawBody = await request.text();
        const event = await verifyStripeWebhook(env, request.headers.get('stripe-signature'), rawBody);

        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
            await upsertSubscription(db, event.data.object);
            break;
          case 'customer.subscription.deleted':
            await db.run('UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?', ['canceled', Date.now(), event.data.object.id]);
            break;
          case 'checkout.session.completed': {
            const session = event.data.object;
            if (session.customer_email && session.customer) {
              const email = session.customer_email.toLowerCase();
              const existing = await db.first('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
              if (!existing) {
                await db.run(
                  `INSERT INTO users (id, email, password_hash, stripe_customer_id, created_at)
                   VALUES (?, ?, ?, ?, ?)`,
                  [crypto.randomUUID(), email, '!LOCKED', String(session.customer), Date.now()],
                );
              } else {
                await db.run('UPDATE users SET stripe_customer_id = ? WHERE email = ?', [String(session.customer), email]);
              }
            }
            break;
          }
          default:
            break;
        }

        return json({ received: true });
      }

      // ── Orchestration: Runs ────────────────────────────────────────────────

      if (request.method === 'GET' && url.pathname === '/v1/runs') {
        const user = await authenticateRequest(request, env, db);
        const workspaceId = url.searchParams.get('workspace_id');
        if (!workspaceId) throw new HttpError(400, { error: 'workspace_id required' });
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
        const rows = await db.all(
          'SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
          [workspaceId, limit],
        );
        return json({ runs: rows.results ?? rows });
      }

      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const { workspace_id, title, policy_json } = body;
        if (!workspace_id || !title) throw new HttpError(400, { error: 'workspace_id and title required' });
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.run(
          'INSERT INTO runs (id, workspace_id, title, status, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, workspace_id, title, 'pending', policy_json ? JSON.stringify(policy_json) : null, now, now],
        );
        const run = await db.first('SELECT * FROM runs WHERE id = ? LIMIT 1', [id]);
        return json({ run }, { status: 201 });
      }

      const runIdMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)$/);
      if (runIdMatch) {
        const user = await authenticateRequest(request, env, db);
        const runId = runIdMatch[1];
        if (request.method === 'GET') {
          const run = await db.first('SELECT * FROM runs WHERE id = ? LIMIT 1', [runId]);
          if (!run) throw new HttpError(404, { error: 'Run not found' });
          return json({ run });
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          const allowed = ['status', 'plan_json', 'selected_option', 'git_branch', 'git_sha_before', 'finished_at'];
          const sets = [];
          const vals = [];
          for (const key of allowed) {
            if (key in body) { sets.push(`${key} = ?`); vals.push(body[key]); }
          }
          if (sets.length === 0) throw new HttpError(400, { error: 'No valid fields to update' });
          sets.push('updated_at = ?'); vals.push(Date.now()); vals.push(runId);
          await db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, vals);
          const run = await db.first('SELECT * FROM runs WHERE id = ? LIMIT 1', [runId]);
          return json({ run });
        }
      }

      const runStepsMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)\/steps$/);
      if (runStepsMatch) {
        const user = await authenticateRequest(request, env, db);
        const runId = runStepsMatch[1];
        if (request.method === 'GET') {
          const rows = await db.all('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq', [runId]);
          return json({ steps: rows.results ?? rows });
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          const id = crypto.randomUUID();
          const seqRow = await db.first('SELECT COALESCE(MAX(seq),0)+1 AS next FROM run_steps WHERE run_id = ?', [runId]);
          const seq = seqRow?.next ?? 1;
          await db.run(
            'INSERT INTO run_steps (id, run_id, phase, label, status, seq, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, runId, body.phase ?? 'custom', body.label ?? '', body.status ?? 'running', seq, Date.now()],
          );
          const step = await db.first('SELECT * FROM run_steps WHERE id = ? LIMIT 1', [id]);
          return json({ step }, { status: 201 });
        }
      }

      const runEventsMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)\/events$/);
      if (runEventsMatch) {
        const user = await authenticateRequest(request, env, db);
        const runId = runEventsMatch[1];
        if (request.method === 'GET') {
          const rows = await db.all('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at', [runId]);
          return json({ events: rows.results ?? rows });
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          const id = crypto.randomUUID();
          await db.run(
            'INSERT INTO run_events (id, run_id, step_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [id, runId, body.step_id ?? null, body.type ?? 'info', body.payload_json ?? null, Date.now()],
          );
          return json({ id }, { status: 201 });
        }
      }

      const runArtifactsMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)\/artifacts$/);
      if (runArtifactsMatch) {
        const user = await authenticateRequest(request, env, db);
        const runId = runArtifactsMatch[1];
        if (request.method === 'GET') {
          const rows = await db.all('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at', [runId]);
          return json({ artifacts: rows.results ?? rows });
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          const id = crypto.randomUUID();
          await db.run(
            'INSERT INTO run_artifacts (id, run_id, step_id, kind, label, content, path, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, runId, body.step_id ?? null, body.kind ?? 'output', body.label ?? null, body.content ?? null, body.path ?? null, body.metadata_json ?? null, Date.now()],
          );
          return json({ id }, { status: 201 });
        }
      }

      // ── Orchestration: Assumptions ─────────────────────────────────────────

      if (request.method === 'GET' && url.pathname === '/v1/assumptions') {
        const user = await authenticateRequest(request, env, db);
        const workspaceId = url.searchParams.get('workspace_id');
        if (!workspaceId) throw new HttpError(400, { error: 'workspace_id required' });
        const includeStale = url.searchParams.get('all') === '1';
        const rows = await db.all(
          `SELECT * FROM assumptions WHERE workspace_id = ?${includeStale ? '' : ' AND stale = 0'} ORDER BY updated_at DESC`,
          [workspaceId],
        );
        return json({ assumptions: rows.results ?? rows });
      }

      if (request.method === 'POST' && url.pathname === '/v1/assumptions') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const { workspace_id, key, value, source } = body;
        if (!workspace_id || !key || !value) throw new HttpError(400, { error: 'workspace_id, key, value required' });
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.run(
          `INSERT INTO assumptions (id, workspace_id, key, value, source, stale, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, stale = 0, updated_at = excluded.updated_at`,
          [id, workspace_id, key, value, source ?? 'user', now, now],
        );
        const row = await db.first('SELECT * FROM assumptions WHERE workspace_id = ? AND key = ? LIMIT 1', [workspace_id, key]);
        return json({ assumption: row }, { status: 201 });
      }

      const assumptionIdMatch = matchPath(url.pathname, /^\/v1\/assumptions\/([^/]+)$/);
      if (assumptionIdMatch) {
        const user = await authenticateRequest(request, env, db);
        const aId = assumptionIdMatch[1];
        if (request.method === 'DELETE') {
          await db.run('DELETE FROM assumptions WHERE id = ?', [aId]);
          return json({ deleted: true });
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          if (body.stale !== undefined) {
            await db.run('UPDATE assumptions SET stale = ?, updated_at = ? WHERE id = ?', [body.stale ? 1 : 0, Date.now(), aId]);
          }
          const row = await db.first('SELECT * FROM assumptions WHERE id = ? LIMIT 1', [aId]);
          return json({ assumption: row });
        }
      }

      // ── Orchestration: Repo Index ──────────────────────────────────────────

      if (request.method === 'GET' && url.pathname === '/v1/index') {
        const user = await authenticateRequest(request, env, db);
        const workspaceId = url.searchParams.get('workspace_id');
        if (!workspaceId) throw new HttpError(400, { error: 'workspace_id required' });
        const kind = url.searchParams.get('kind');
        const rows = await db.all(
          `SELECT * FROM repo_index WHERE workspace_id = ?${kind ? ' AND kind = ?' : ''} ORDER BY kind, path`,
          kind ? [workspaceId, kind] : [workspaceId],
        );
        return json({ entries: rows.results ?? rows });
      }

      if (request.method === 'POST' && url.pathname === '/v1/index') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const { workspace_id, entries } = body;
        if (!workspace_id || !Array.isArray(entries)) throw new HttpError(400, { error: 'workspace_id and entries[] required' });
        const now = Date.now();
        for (const e of entries) {
          const id = crypto.randomUUID();
          await db.run(
            `INSERT INTO repo_index (id, workspace_id, kind, path, label, metadata_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, kind, path) DO UPDATE SET label = excluded.label, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
            [id, workspace_id, e.kind, e.path, e.label ?? e.path, e.metadata_json ?? null, now],
          );
        }
        return json({ upserted: entries.length }, { status: 201 });
      }

      if (request.method === 'DELETE' && url.pathname === '/v1/index') {
        const user = await authenticateRequest(request, env, db);
        const workspaceId = url.searchParams.get('workspace_id');
        if (!workspaceId) throw new HttpError(400, { error: 'workspace_id required' });
        const kind = url.searchParams.get('kind');
        await db.run(
          `DELETE FROM repo_index WHERE workspace_id = ?${kind ? ' AND kind = ?' : ''}`,
          kind ? [workspaceId, kind] : [workspaceId],
        );
        return json({ deleted: true });
      }

      // ── Orchestration: Evals ───────────────────────────────────────────────

      if (request.method === 'GET' && url.pathname === '/v1/evals/tasks') {
        const user = await authenticateRequest(request, env, db);
        const workspaceId = url.searchParams.get('workspace_id');
        if (!workspaceId) throw new HttpError(400, { error: 'workspace_id required' });
        const all = url.searchParams.get('all') === '1';
        const rows = await db.all(
          `SELECT * FROM eval_tasks WHERE workspace_id = ?${all ? '' : " AND status = 'active'"} ORDER BY created_at DESC`,
          [workspaceId],
        );
        return json({ tasks: rows.results ?? rows });
      }

      if (request.method === 'POST' && url.pathname === '/v1/evals/tasks') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const { workspace_id, title, description, acceptance } = body;
        if (!workspace_id || !title || !description) throw new HttpError(400, { error: 'workspace_id, title, description required' });
        const id = crypto.randomUUID();
        await db.run(
          'INSERT INTO eval_tasks (id, workspace_id, title, description, acceptance_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, workspace_id, title, description, acceptance ? JSON.stringify(acceptance) : null, 'active', Date.now()],
        );
        const task = await db.first('SELECT * FROM eval_tasks WHERE id = ? LIMIT 1', [id]);
        return json({ task }, { status: 201 });
      }

      if (request.method === 'GET' && url.pathname === '/v1/evals/results') {
        const user = await authenticateRequest(request, env, db);
        const evalTaskId = url.searchParams.get('eval_task_id');
        if (!evalTaskId) throw new HttpError(400, { error: 'eval_task_id required' });
        const rows = await db.all('SELECT * FROM eval_results WHERE eval_task_id = ? ORDER BY created_at DESC', [evalTaskId]);
        return json({ results: rows.results ?? rows });
      }

      if (request.method === 'POST' && url.pathname === '/v1/evals/results') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const { eval_task_id, agent, model, passed, score, notes, run_id } = body;
        if (!eval_task_id || !agent) throw new HttpError(400, { error: 'eval_task_id and agent required' });
        const id = crypto.randomUUID();
        await db.run(
          'INSERT INTO eval_results (id, eval_task_id, run_id, agent, model, passed, score, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, eval_task_id, run_id ?? null, agent, model ?? null, passed != null ? (passed ? 1 : 0) : null, score ?? null, notes ?? null, Date.now()],
        );
        return json({ id }, { status: 201 });
      }

      // ── Agent Sessions ────────────────────────────────────────────────────

      if (request.method === 'GET' && url.pathname === '/v1/agent-sessions') {
        const user = await authenticateRequest(request, env, db);
        const workspaceId = url.searchParams.get('workspace_id');
        if (!workspaceId) throw new HttpError(400, { error: 'workspace_id required' });
        const status = url.searchParams.get('status');
        const rows = await db.all(
          `SELECT * FROM agent_sessions WHERE workspace_id = ?${status ? ' AND status = ?' : ''} ORDER BY started_at DESC LIMIT 50`,
          status ? [workspaceId, status] : [workspaceId],
        );
        return json({ sessions: rows.results ?? rows });
      }

      if (request.method === 'POST' && url.pathname === '/v1/agent-sessions') {
        const user = await authenticateRequest(request, env, db);
        const body = await readJson(request);
        const { workspace_id, agent, goal, run_id } = body;
        if (!workspace_id) throw new HttpError(400, { error: 'workspace_id required' });
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.run(
          `INSERT INTO agent_sessions (id, workspace_id, run_id, agent, status, goal, started_at, last_heartbeat_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
          [id, workspace_id, run_id ?? null, agent ?? 'unknown', goal ?? null, now, now],
        );
        const session = await db.first('SELECT * FROM agent_sessions WHERE id = ? LIMIT 1', [id]);
        return json({ session }, { status: 201 });
      }

      const agentSessionIdMatch = matchPath(url.pathname, /^\/v1\/agent-sessions\/([^/]+)$/);
      if (agentSessionIdMatch) {
        const user = await authenticateRequest(request, env, db);
        const sessionId = agentSessionIdMatch[1];
        if (request.method === 'GET') {
          const session = await db.first('SELECT * FROM agent_sessions WHERE id = ? LIMIT 1', [sessionId]);
          if (!session) throw new HttpError(404, { error: 'Agent session not found' });
          return json({ session });
        }
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          const allowed = ['status', 'goal', 'blocker', 'files_changed_json', 'stash_ref', 'snapshot_json', 'ended_at'];
          const sets = [];
          const vals = [];
          for (const key of allowed) {
            if (key in body) { sets.push(`${key} = ?`); vals.push(body[key]); }
          }
          sets.push('last_heartbeat_at = ?'); vals.push(Date.now());
          if (sets.length === 1) throw new HttpError(400, { error: 'No valid fields' });
          vals.push(sessionId);
          await db.run(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`, vals);
          const session = await db.first('SELECT * FROM agent_sessions WHERE id = ? LIMIT 1', [sessionId]);
          return json({ session });
        }
      }

      // ── Rollback ──────────────────────────────────────────────────────────

      const runRollbackMatch = matchPath(url.pathname, /^\/v1\/runs\/([^/]+)\/rollback$/);
      if (request.method === 'POST' && runRollbackMatch) {
        const user = await authenticateRequest(request, env, db);
        const runId = runRollbackMatch[1];
        const run = await db.first('SELECT * FROM runs WHERE id = ? LIMIT 1', [runId]);
        if (!run) throw new HttpError(404, { error: 'Run not found' });
        await db.run(
          `UPDATE runs SET status = 'rolled_back', updated_at = ? WHERE id = ?`,
          [Date.now(), runId],
        );
        return json({ ok: true, runId, note: 'Run marked as rolled_back. Apply git stash manually using stash_ref if present.' });
      }

    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.body, { status: error.status });
      }

      console.error(error);
      return json({ error: 'Internal server error' }, { status: 500 });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json(
      {
        error: 'Cloudflare worker routes are not fully ported yet.',
      },
      { status: 501 },
    );
  },

  async scheduled(_event, env, _ctx) {
    const db = createD1Client(env.DB);
    const result = await compactLatestBrainRows(db);
    console.log('Scheduled brain compaction complete', result);
  },
};

async function getOwnedWorkspace(db, workspaceId, userId, requireExisting) {
  const workspace = await db.first('SELECT user_id FROM workspaces WHERE id = ? LIMIT 1', [workspaceId]);
  if (!workspace) {
    if (requireExisting) return null;
    return null;
  }
  if (workspace.user_id !== userId) {
    throw new HttpError(403, { error: 'Access denied' });
  }
  return workspace;
}

async function ensureWorkspaceOwned(db, workspaceId, userId, autoCreate) {
  const workspace = await db.first('SELECT user_id FROM workspaces WHERE id = ? LIMIT 1', [workspaceId]);
  if (!workspace) {
    if (!autoCreate) throw new HttpError(404, { error: 'Workspace not found' });
    await db.run(
      'INSERT INTO workspaces (id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [workspaceId, userId, Date.now()],
    );
    return;
  }
  if (workspace.user_id !== userId) throw new HttpError(403, { error: 'Access denied' });
}

function assembleChunks(rows, kind) {
  const chunks = rows.filter((row) => row.kind === kind).sort((a, b) => a.chunk_index - b.chunk_index);
  if (chunks.length === 0) return null;
  const total = Number(chunks[0].total_chunks);
  if (!Number.isInteger(total) || total < 1 || chunks.length !== total) return null;
  for (let index = 0; index < total; index++) {
    if (Number(chunks[index]?.chunk_index) !== index || Number(chunks[index]?.total_chunks) !== total) {
      return null;
    }
  }
  return chunks.map((chunk) => chunk.data).join('');
}

async function upsertSubscription(db, subscription) {
  const customerId = String(subscription.customer);
  const user = await db.first('SELECT id FROM users WHERE stripe_customer_id = ? LIMIT 1', [customerId]);
  if (!user) return;
  const priceId = subscription.items?.data?.[0]?.price?.id ?? '';
  await db.run(
    `INSERT INTO subscriptions (
       id, user_id, stripe_subscription_id, stripe_price_id, status, current_period_end, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       updated_at = excluded.updated_at`,
    [
      crypto.randomUUID(),
      user.id,
      subscription.id,
      priceId,
      subscription.status,
      Number(subscription.current_period_end) * 1000,
      Date.now(),
      Date.now(),
    ],
  );
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, { error: 'Invalid JSON body' });
  }
}

function matchPath(pathname, regex) {
  const match = pathname.match(regex);
  if (!match) return null;
  return match.map((value, index) => (index === 0 ? value : decodePathParam(value)));
}

function decodePathParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCheckpointMeta(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 6) : null;
  } catch {
    return null;
  }
}

function toIsoString(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && String(numeric) === String(value)) {
    return new Date(numeric).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const numeric = Number(value ?? 0);
  return Number.isNaN(numeric) ? 0 : numeric;
}