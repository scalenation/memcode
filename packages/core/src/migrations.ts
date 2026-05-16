/**
 * Embedded SQL migrations — embedded as strings so the compiled dist/ folder
 * has no dependency on external .sql files at runtime.
 */
export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_baseline',
    sql: `
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  path_hash   TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  editor       TEXT,
  agent        TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT    PRIMARY KEY,
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content     TEXT    NOT NULL,
  token_count INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id            TEXT    PRIMARY KEY,
  workspace_id  TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    TEXT    REFERENCES sessions(id),
  git_sha       TEXT,
  branch        TEXT,
  trigger       TEXT    NOT NULL,
  summary_short TEXT    NOT NULL,
  summary_long  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT    PRIMARY KEY,
  workspace_id  TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  rationale     TEXT    NOT NULL,
  impact        TEXT,
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'superseded', 'rejected')),
  checkpoint_id TEXT    REFERENCES checkpoints(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT    PRIMARY KEY,
  workspace_id  TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  description   TEXT,
  status        TEXT    NOT NULL DEFAULT 'open'
                        CHECK(status IN ('open', 'in-progress', 'done', 'cancelled')),
  priority      TEXT    CHECK(priority IN ('low', 'medium', 'high')),
  decision_id   TEXT    REFERENCES decisions(id),
  checkpoint_id TEXT    REFERENCES checkpoints(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  path          TEXT,
  hash          TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  workspace_id  TEXT    PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  last_cursor   TEXT,
  last_synced_at INTEGER,
  provider      TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace_created
  ON checkpoints(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_workspace_created
  ON decisions(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status
  ON tasks(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created
  ON tasks(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, created_at);
    `,
  },
  {
    name: '002_session_telemetry',
    sql: `
ALTER TABLE sessions ADD COLUMN source TEXT;
ALTER TABLE sessions ADD COLUMN provider TEXT;
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN task_label TEXT;
ALTER TABLE sessions ADD COLUMN category TEXT;
    `,
  },
];
