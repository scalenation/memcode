import 'dotenv/config';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './client';

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  stripe_customer_id: string | null;
  oauth_provider: string | null;
  oauth_sub: string | null;
  name: string | null;
  openrouter_api_key_encrypted: string | null;
  openrouter_model: string | null;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  status: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  user_id: string;
  name: string | null;
  machine_name: string | null;
  created_at: string;
};

type SyncBlobRow = {
  id: string;
  workspace_id: string;
  cursor: string;
  payload_encrypted: string | null;
  payload_storage_key: string | null;
  payload_size: string | null;
  ip: string | null;
  user_agent: string | null;
  label: string | null;
  meta: unknown;
  brain: unknown;
  created_at: string;
};

type SessionRow = {
  id: string;
  user_id: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  revoked: boolean;
};

type MagicLinkTokenRow = {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  used: boolean;
};

async function exportCloudflareMigration(): Promise<void> {
  const outputDir = resolve(process.argv[2] ?? 'tmp/cloudflare-migration');
  await mkdir(outputDir, { recursive: true });

  const [
    users,
    subscriptions,
    workspaces,
    syncBlobs,
    sessions,
    magicLinkTokens,
  ] = await Promise.all([
    pool.query<UserRow>(
      `SELECT id, email, password_hash, stripe_customer_id, oauth_provider, oauth_sub,
              name, openrouter_api_key_encrypted, openrouter_model, created_at
       FROM users
       ORDER BY created_at ASC`,
    ),
    pool.query<SubscriptionRow>(
      `SELECT id, user_id, stripe_subscription_id, stripe_price_id, status,
              current_period_end, created_at, updated_at
       FROM subscriptions
       ORDER BY created_at ASC`,
    ),
    pool.query<WorkspaceRow>(
      `SELECT id, user_id, name, machine_name, created_at
       FROM workspaces
       ORDER BY created_at ASC`,
    ),
    pool.query<SyncBlobRow>(
      `SELECT id, workspace_id, cursor, payload_encrypted, payload_storage_key, payload_size,
              ip, user_agent, label, meta, brain, created_at
       FROM sync_blobs
       ORDER BY created_at ASC`,
    ),
    pool.query<SessionRow>(
      `SELECT id, user_id, ip, user_agent, created_at, last_seen_at, revoked
       FROM sessions
       ORDER BY created_at ASC`,
    ).catch(() => ({ rows: [], rowCount: 0 })),
    pool.query<MagicLinkTokenRow>(
      `SELECT id, user_id, token, expires_at, used
       FROM magic_link_tokens
       ORDER BY expires_at ASC`,
    ).catch(() => ({ rows: [], rowCount: 0 })),
  ]);

  await writeNdjson(`${outputDir}/users.ndjson`, users.rows.map((row) => ({
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    stripe_customer_id: row.stripe_customer_id,
    oauth_provider: row.oauth_provider,
    oauth_sub: row.oauth_sub,
    name: row.name,
    openrouter_api_key_encrypted: row.openrouter_api_key_encrypted,
    openrouter_model: row.openrouter_model,
    created_at: toUnixMillis(row.created_at),
  })));

  await writeNdjson(`${outputDir}/subscriptions.ndjson`, subscriptions.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    stripe_subscription_id: row.stripe_subscription_id,
    stripe_price_id: row.stripe_price_id,
    status: row.status,
    current_period_end: toUnixMillis(row.current_period_end),
    created_at: toUnixMillis(row.created_at),
    updated_at: toUnixMillis(row.updated_at),
  })));

  await writeNdjson(`${outputDir}/workspaces.ndjson`, workspaces.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    machine_name: row.machine_name,
    created_at: toUnixMillis(row.created_at),
  })));

  await writeNdjson(`${outputDir}/sync-blobs.ndjson`, syncBlobs.rows.map((row) => {
    const payloadStorageKey = row.payload_storage_key ?? defaultBlobStorageKey(row.workspace_id, row.cursor, row.id);
    const payloadSize = row.payload_size
      ? parseInt(row.payload_size, 10)
      : Buffer.byteLength(row.payload_encrypted ?? '', 'utf8');

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      cursor: row.cursor,
      payload_encrypted: null,
      payload_storage_key: payloadStorageKey,
      payload_size: payloadSize,
      ip: row.ip,
      user_agent: row.user_agent,
      label: row.label,
      meta: row.meta == null ? null : JSON.stringify(row.meta),
      brain: row.brain == null ? null : JSON.stringify(row.brain),
      created_at: toUnixMillis(row.created_at),
    };
  }));

  await writeNdjson(`${outputDir}/r2-sync-blobs.ndjson`, syncBlobs.rows.map((row) => ({
    key: row.payload_storage_key ?? defaultBlobStorageKey(row.workspace_id, row.cursor, row.id),
    blob_id: row.id,
    workspace_id: row.workspace_id,
    cursor: row.cursor,
    payload_encrypted: row.payload_encrypted,
  })));

  await writeNdjson(`${outputDir}/sessions.ndjson`, sessions.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    ip: row.ip,
    user_agent: row.user_agent,
    created_at: toUnixMillis(row.created_at),
    last_seen_at: toUnixMillis(row.last_seen_at),
    revoked: row.revoked ? 1 : 0,
  })));

  await writeNdjson(`${outputDir}/magic-link-tokens.ndjson`, magicLinkTokens.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    token: row.token,
    expires_at: toUnixMillis(row.expires_at),
    used: row.used ? 1 : 0,
  })));

  const manifest = {
    exportedAt: new Date().toISOString(),
    outputDir,
    counts: {
      users: users.rowCount,
      subscriptions: subscriptions.rowCount,
      workspaces: workspaces.rowCount,
      syncBlobs: syncBlobs.rowCount,
      sessions: sessions.rowCount,
      magicLinkTokens: magicLinkTokens.rowCount,
    },
  };

  await writeFile(`${outputDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

function defaultBlobStorageKey(workspaceId: string, cursor: string, blobId: string): string {
  return `blobs/${workspaceId}/${cursor}-${blobId}.bin`;
}

function toUnixMillis(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return timestamp;
}

async function writeNdjson(filePath: string, rows: unknown[]): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(filePath, body.length > 0 ? `${body}\n` : '');
}

exportCloudflareMigration().catch((error) => {
  console.error('Cloudflare migration export failed:', error);
  process.exit(1);
});