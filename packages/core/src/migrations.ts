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
  {
    name: '003_orchestration',
    sql: `
-- ── Agent Runs ───────────────────────────────────────────────────────────────
-- A Run is one unit of agent work: a task requested by a developer that
-- proceeds through phases (plan → approve → execute → validate → commit).
CREATE TABLE IF NOT EXISTS runs (
  id               TEXT    PRIMARY KEY,
  workspace_id     TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            TEXT    NOT NULL,
  description      TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending'
                           CHECK(status IN ('pending','planning','awaiting-approval',
                                            'executing','paused','validating',
                                            'done','failed','cancelled','rolled-back')),
  policy_json      TEXT,
  git_branch       TEXT,
  git_sha_before   TEXT,
  git_stash_ref    TEXT,
  git_worktree     TEXT,
  plan_json        TEXT,
  selected_option  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  finished_at      INTEGER
);

-- ── Run Steps ─────────────────────────────────────────────────────────────────
-- Each step is one phase in the execution DAG.
CREATE TABLE IF NOT EXISTS run_steps (
  id           TEXT    PRIMARY KEY,
  run_id       TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase        TEXT    NOT NULL
                       CHECK(phase IN ('retrieve','plan','approve','build',
                                       'validate','review','commit','deploy','custom')),
  label        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','running','done','failed','skipped')),
  input_json   TEXT,
  output_json  TEXT,
  model        TEXT,
  cost_usd     REAL,
  started_at   INTEGER,
  finished_at  INTEGER,
  seq          INTEGER NOT NULL DEFAULT 0
);

-- ── Run Events ────────────────────────────────────────────────────────────────
-- Structured event log: every command, file edit, model call, tool call.
CREATE TABLE IF NOT EXISTS run_events (
  id           TEXT    PRIMARY KEY,
  run_id       TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id      TEXT    REFERENCES run_steps(id),
  type         TEXT    NOT NULL,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);

-- ── Run Artifacts ─────────────────────────────────────────────────────────────
-- Outputs produced during a run: plans, diffs, test results, generated docs.
CREATE TABLE IF NOT EXISTS run_artifacts (
  id           TEXT    PRIMARY KEY,
  run_id       TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id      TEXT    REFERENCES run_steps(id),
  kind         TEXT    NOT NULL,
  label        TEXT,
  content      TEXT,
  path         TEXT,
  metadata_json TEXT,
  created_at   INTEGER NOT NULL
);

-- ── Assumptions ──────────────────────────────────────────────────────────────
-- Active knowledge the agent has learned about the codebase.
-- Devs can edit, invalidate, or remove entries to correct false assumptions.
CREATE TABLE IF NOT EXISTS assumptions (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'agent'
                       CHECK(source IN ('agent','user','detected','imported')),
  stale        INTEGER NOT NULL DEFAULT 0,
  run_id       TEXT    REFERENCES runs(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(workspace_id, key)
);

-- ── Repo Index ────────────────────────────────────────────────────────────────
-- Auto-maintained catalog of project components, routes, schemas, tests, etc.
CREATE TABLE IF NOT EXISTS repo_index (
  id            TEXT    PRIMARY KEY,
  workspace_id  TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL
                        CHECK(kind IN ('component','endpoint','schema','test',
                                       'script','convention','module','bridge')),
  path          TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  metadata_json TEXT,
  updated_at    INTEGER NOT NULL,
  UNIQUE(workspace_id, kind, path)
);

-- ── Eval Tasks ────────────────────────────────────────────────────────────────
-- Benchmark tasks used to evaluate agent/model/prompt changes.
CREATE TABLE IF NOT EXISTS eval_tasks (
  id             TEXT    PRIMARY KEY,
  workspace_id   TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title          TEXT    NOT NULL,
  description    TEXT,
  acceptance_json TEXT,
  status         TEXT    NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','archived')),
  created_at     INTEGER NOT NULL
);

-- ── Eval Results ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_results (
  id           TEXT    PRIMARY KEY,
  eval_task_id TEXT    NOT NULL REFERENCES eval_tasks(id) ON DELETE CASCADE,
  run_id       TEXT    REFERENCES runs(id),
  agent        TEXT,
  model        TEXT,
  passed       INTEGER NOT NULL DEFAULT 0,
  score        REAL,
  notes        TEXT,
  created_at   INTEGER NOT NULL
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_runs_workspace_created
  ON runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_steps_run
  ON run_steps(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_run
  ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assumptions_workspace
  ON assumptions(workspace_id, stale, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_index_workspace_kind
  ON repo_index(workspace_id, kind);
CREATE INDEX IF NOT EXISTS idx_eval_tasks_workspace
  ON eval_tasks(workspace_id, status);
    `,
  },
];
