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
-- ── Orchestration tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  policy_json TEXT,
  git_branch TEXT,
  git_sha_before TEXT,
  git_stash_ref TEXT,
  git_worktree TEXT,
  plan_json TEXT,
  selected_option INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS runs_workspace_status_idx ON runs(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT,
  output_json TEXT,
  model TEXT,
  cost_usd REAL,
  seq INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS run_steps_run_idx ON run_steps(run_id, seq);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, created_at);

CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT,
  kind TEXT NOT NULL,
  label TEXT,
  content TEXT,
  path TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS run_artifacts_run_idx ON run_artifacts(run_id);

CREATE TABLE IF NOT EXISTS assumptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  stale INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, key)
);

CREATE INDEX IF NOT EXISTS assumptions_workspace_idx ON assumptions(workspace_id, stale);

CREATE TABLE IF NOT EXISTS repo_index (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT NOT NULL,
  metadata_json TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id, kind, path)
);

CREATE INDEX IF NOT EXISTS repo_index_workspace_kind_idx ON repo_index(workspace_id, kind);

CREATE TABLE IF NOT EXISTS eval_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  eval_task_id TEXT NOT NULL REFERENCES eval_tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  agent TEXT NOT NULL,
  model TEXT,
  passed INTEGER,
  score REAL,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS eval_results_task_idx ON eval_results(eval_task_id, created_at DESC);
