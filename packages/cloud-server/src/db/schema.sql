-- MemCode cloud database schema
-- Run once via: pnpm migrate

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL UNIQUE,
  password_hash TEXT      NOT NULL,
  stripe_customer_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT        NOT NULL UNIQUE,
  stripe_price_id        TEXT        NOT NULL,
  status                 TEXT        NOT NULL, -- 'active' | 'trialing' | 'past_due' | 'canceled'
  current_period_end     TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);

-- OAuth / SSO login support
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_sub      TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_oauth_idx ON users(oauth_provider, oauth_sub) WHERE oauth_provider IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS openrouter_api_key_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS openrouter_model TEXT;

-- A workspace is identified by the local UUID from memory.db
-- One user can have many workspaces (one per repo)
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT        PRIMARY KEY,           -- local workspace UUID
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspaces_user_id_idx ON workspaces(user_id);

-- Each push stores one encrypted blob. Server never decrypts these.
-- cursor is a millisecond timestamp string used for ordering and delta pulls.
CREATE TABLE IF NOT EXISTS sync_blobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cursor            TEXT        NOT NULL,
  payload_encrypted TEXT,                  -- base64 AES-256-GCM, client-side encrypted
  payload_storage_key TEXT,
  payload_size      BIGINT,
  brain             JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sync_blobs_workspace_cursor_idx ON sync_blobs(workspace_id, cursor);

CREATE TABLE IF NOT EXISTS sync_upload_chunks (
  upload_id    TEXT        NOT NULL,
  workspace_id  TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL CHECK (kind IN ('payload', 'meta')),
  chunk_index   INTEGER     NOT NULL,
  total_chunks  INTEGER     NOT NULL,
  data          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (upload_id, kind, chunk_index)
);

CREATE INDEX IF NOT EXISTS sync_upload_chunks_workspace_idx ON sync_upload_chunks(workspace_id, created_at);
