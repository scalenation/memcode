PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  oauth_provider TEXT,
  oauth_sub TEXT,
  name TEXT,
  openrouter_api_key_encrypted TEXT,
  openrouter_model TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_oauth_idx ON users(oauth_provider, oauth_sub);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_price_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  machine_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS workspaces_user_id_idx ON workspaces(user_id);

CREATE TABLE IF NOT EXISTS sync_blobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cursor TEXT NOT NULL,
  payload_encrypted TEXT,
  payload_storage_key TEXT,
  payload_size INTEGER,
  ip TEXT,
  user_agent TEXT,
  label TEXT,
  meta TEXT,
  brain TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_blobs_workspace_cursor_idx ON sync_blobs(workspace_id, cursor);
CREATE INDEX IF NOT EXISTS sync_blobs_payload_storage_key_idx ON sync_blobs(payload_storage_key);

CREATE TABLE IF NOT EXISTS sync_upload_chunks (
  upload_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('payload', 'meta')),
  chunk_index INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, kind, chunk_index)
);

CREATE INDEX IF NOT EXISTS sync_upload_chunks_workspace_idx ON sync_upload_chunks(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT,
  category TEXT NOT NULL,
  operation TEXT NOT NULL,
  report_type TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  credits_used REAL,
  response_ms INTEGER,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_usage_events_user_created_idx ON ai_usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_project_idx ON ai_usage_events(user_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_category_idx ON ai_usage_events(user_id, category, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS magic_link_tokens_token_idx ON magic_link_tokens(token);