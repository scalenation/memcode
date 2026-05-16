import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  generateContextPack,
  getTimeline,
  getOrCreateWorkspace,
  openDb,
  recall,
} from '@memcode/core';
import { configuredAgentFilePaths } from '../assistant-adapters';
import { refreshConfiguredAssistantContext } from '../assistant-context';
import { findProjectRoot, getMemoryDir, resolveProject } from '../util';

interface ServiceState {
  pid: number;
  projectPath: string;
  port: number;
  intervalSeconds: number;
  startedAt: string;
}

interface ServiceRuntime {
  workspaceId: string;
  workspaceName: string;
  lastTickAt: string | null;
  lastImportedSessions: number;
  lastImportedMessages: number;
  refreshedFiles: number;
}

interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  created_at: number;
  updated_at: number;
}

interface DecisionRecord {
  id: string;
  title: string;
  rationale: string;
  impact: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface CheckpointRecord {
  id: string;
  summary_short: string;
  summary_long: string | null;
  trigger: string;
  branch: string | null;
  git_sha: string | null;
  created_at: number;
}

interface DashboardSummary {
  workspaceId: string;
  workspaceName: string;
  taskCounts: Record<string, number>;
  decisionCounts: Record<string, number>;
  checkpointCount: number;
  sessionCount: number;
  assistantFileCount: number;
  runtime: ServiceRuntime;
}

interface ActivityBucket {
  day: string;
  tasks: number;
  decisions: number;
  checkpoints: number;
  total: number;
}

interface ActivitySummary {
  days: number;
  from: number;
  to: number;
  totals: {
    tasks: number;
    decisions: number;
    checkpoints: number;
    total: number;
  };
  buckets: ActivityBucket[];
}

export const serviceCommand = new Command('service')
  .description('Run the always-on local MemCode worker for assistant refresh and local search');

function serviceStatePath(projectPath: string): string {
  return join(getMemoryDir(projectPath), 'service.json');
}

function readServiceState(projectPath: string): ServiceState | null {
  const filePath = serviceStatePath(projectPath);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ServiceState;
  } catch {
    return null;
  }
}

function clearServiceState(projectPath: string): void {
  const filePath = serviceStatePath(projectPath);
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // best effort
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultServicePort(projectPath: string): number {
  const hash = createHash('sha256').update(projectPath).digest();
  return 39000 + (hash.readUInt16BE(0) % 1000);
}

async function runMaintenance(projectPath: string): Promise<ServiceRuntime> {
  const { db, workspace } = resolveProject(projectPath);
  try {
    const result = refreshConfiguredAssistantContext(db, workspace, projectPath);
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      lastTickAt: new Date().toISOString(),
      lastImportedSessions: result.imported.sessions,
      lastImportedMessages: result.imported.messages,
      refreshedFiles: result.refreshedFiles.length,
    };
  } finally {
    db.close();
  }
}

function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function text(res: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function parseLimit(url: URL, fallback: number, max: number): number {
  const raw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(raw, max);
}

function parseQuery(url: URL): string | null {
  const query = (url.searchParams.get('q') ?? '').trim();
  return query.length > 0 ? query : null;
}

function parseDays(url: URL, fallback: number, max: number): number {
  const raw = Number.parseInt(url.searchParams.get('days') ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(raw, max);
}

function likeQuery(query: string | null): string | null {
  return query ? `%${query}%` : null;
}

function searchClause(columns: string[], query: string | null): { clause: string; params: string[] } {
  if (!query) return { clause: '', params: [] };
  const like = likeQuery(query) as string;
  return {
    clause: ` AND (${columns.map((column) => `${column} LIKE ?`).join(' OR ')})`,
    params: columns.map(() => like),
  };
}

function getTaskRecords(db: ReturnType<typeof openDb>, workspaceId: string, status: string | null, query: string | null, limit: number): TaskRecord[] {
  const statusClause = status && status !== 'all' ? ' AND status = ?' : '';
  const statusParams = status && status !== 'all' ? [status] : [];
  const search = searchClause(['title', 'description'], query);
  return db.prepare(
    `SELECT id, title, description, status, priority, created_at, updated_at
     FROM tasks
     WHERE workspace_id = ?${statusClause}${search.clause}
     ORDER BY
       CASE status WHEN 'open' THEN 1 WHEN 'in-progress' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
       CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       updated_at DESC
     LIMIT ?`,
  ).all(workspaceId, ...statusParams, ...search.params, limit) as unknown as TaskRecord[];
}

function getDecisionRecords(db: ReturnType<typeof openDb>, workspaceId: string, status: string | null, query: string | null, limit: number): DecisionRecord[] {
  const statusClause = status && status !== 'all' ? ' AND status = ?' : '';
  const statusParams = status && status !== 'all' ? [status] : [];
  const search = searchClause(['title', 'rationale', 'impact'], query);
  return db.prepare(
    `SELECT id, title, rationale, impact, status, created_at, updated_at
     FROM decisions
     WHERE workspace_id = ?${statusClause}${search.clause}
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(workspaceId, ...statusParams, ...search.params, limit) as unknown as DecisionRecord[];
}

function getCheckpointRecords(db: ReturnType<typeof openDb>, workspaceId: string, query: string | null, limit: number): CheckpointRecord[] {
  const search = searchClause(['summary_short', 'summary_long', 'branch', 'trigger'], query);
  return db.prepare(
    `SELECT id, summary_short, summary_long, trigger, branch, git_sha, created_at
     FROM checkpoints
     WHERE workspace_id = ?${search.clause}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(workspaceId, ...search.params, limit) as unknown as CheckpointRecord[];
}

function getDashboardSummary(
  db: ReturnType<typeof openDb>,
  workspaceId: string,
  runtime: ServiceRuntime,
  projectPath: string,
): DashboardSummary {
  const taskCounts = db.prepare(
    `SELECT status, COUNT(*) AS total
     FROM tasks
     WHERE workspace_id = ?
     GROUP BY status`,
  ).all(workspaceId) as Array<{ status: string; total: number }>;
  const decisionCounts = db.prepare(
    `SELECT status, COUNT(*) AS total
     FROM decisions
     WHERE workspace_id = ?
     GROUP BY status`,
  ).all(workspaceId) as Array<{ status: string; total: number }>;
  const checkpointCount = db.prepare('SELECT COUNT(*) AS total FROM checkpoints WHERE workspace_id = ?').get(workspaceId) as { total: number };
  const sessionCount = db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE workspace_id = ?').get(workspaceId) as { total: number };
  return {
    workspaceId,
    workspaceName: runtime.workspaceName,
    taskCounts: Object.fromEntries(taskCounts.map((row) => [row.status, Number(row.total)])),
    decisionCounts: Object.fromEntries(decisionCounts.map((row) => [row.status, Number(row.total)])),
    checkpointCount: Number(checkpointCount.total ?? 0),
    sessionCount: Number(sessionCount.total ?? 0),
    assistantFileCount: configuredAgentFilePaths(projectPath).length,
    runtime,
  };
}

function getActivitySummary(
  db: ReturnType<typeof openDb>,
  workspaceId: string,
  days: number,
): ActivitySummary {
  const now = Date.now();
  const from = now - (days - 1) * 24 * 60 * 60 * 1000;

  const mergeRows = (
    rows: Array<{ day: string; total: number }>,
    field: 'tasks' | 'decisions' | 'checkpoints',
    buckets: Map<string, ActivityBucket>,
  ) => {
    for (const row of rows) {
      const existing = buckets.get(row.day) ?? {
        day: row.day,
        tasks: 0,
        decisions: 0,
        checkpoints: 0,
        total: 0,
      };
      existing[field] = Number(row.total);
      existing.total = existing.tasks + existing.decisions + existing.checkpoints;
      buckets.set(row.day, existing);
    }
  };

  const taskRows = db.prepare(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS total
     FROM tasks
     WHERE workspace_id = ? AND created_at >= ?
     GROUP BY day
     ORDER BY day DESC`,
  ).all(workspaceId, from) as Array<{ day: string; total: number }>;

  const decisionRows = db.prepare(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS total
     FROM decisions
     WHERE workspace_id = ? AND created_at >= ?
     GROUP BY day
     ORDER BY day DESC`,
  ).all(workspaceId, from) as Array<{ day: string; total: number }>;

  const checkpointRows = db.prepare(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS total
     FROM checkpoints
     WHERE workspace_id = ? AND created_at >= ?
     GROUP BY day
     ORDER BY day DESC`,
  ).all(workspaceId, from) as Array<{ day: string; total: number }>;

  const buckets = new Map<string, ActivityBucket>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const bucketDate = new Date(now - offset * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    buckets.set(bucketDate, {
      day: bucketDate,
      tasks: 0,
      decisions: 0,
      checkpoints: 0,
      total: 0,
    });
  }

  mergeRows(taskRows, 'tasks', buckets);
  mergeRows(decisionRows, 'decisions', buckets);
  mergeRows(checkpointRows, 'checkpoints', buckets);

  const bucketList = Array.from(buckets.values()).sort((left, right) =>
    right.day.localeCompare(left.day),
  );

  const totals = bucketList.reduce(
    (acc, bucket) => {
      acc.tasks += bucket.tasks;
      acc.decisions += bucket.decisions;
      acc.checkpoints += bucket.checkpoints;
      acc.total += bucket.total;
      return acc;
    },
    { tasks: 0, decisions: 0, checkpoints: 0, total: 0 },
  );

  return {
    days,
    from,
    to: now,
    totals,
    buckets: bucketList,
  };
}

function renderViewerHtml(port: number, projectPath: string): string {
  const filterStorageKey = JSON.stringify(`memcode.dashboard.filters:${projectPath}`);
  const currentFilterStorageKey = JSON.stringify(`memcode.dashboard.current:${projectPath}`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MemCode Local Dashboard</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top, #16213d 0%, #0b1020 48%, #060814 100%); color: #edf2f7; }
    .page { max-width: 1240px; margin: 0 auto; padding: 32px 20px 48px; }
    .hero { display: grid; gap: 10px; margin-bottom: 24px; }
    .eyebrow { color: #60a5fa; font-size: 0.82rem; letter-spacing: 0.12em; text-transform: uppercase; }
    .hero h1 { margin: 0; font-size: 2rem; }
    .hero p { margin: 0; color: #a0aec0; max-width: 900px; }
    .meta { font-size: 0.88rem; color: #94a3b8; }
    .stats { display: grid; gap: 14px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 20px 0 26px; }
    .stat { background: rgba(15, 23, 42, 0.88); border: 1px solid #22314f; border-radius: 16px; padding: 16px 18px; }
    .stat .label { color: #94a3b8; font-size: 0.82rem; }
    .stat .value { font-size: 1.8rem; font-weight: 700; margin-top: 8px; }
    .grid { display: grid; gap: 18px; grid-template-columns: 1.15fr 0.85fr; }
    .stack { display: grid; gap: 18px; }
    .card { background: rgba(15, 23, 42, 0.9); border: 1px solid #1f2937; border-radius: 18px; padding: 18px; box-shadow: 0 12px 30px rgba(0,0,0,0.18); }
    .card h2 { margin: 0 0 6px; font-size: 1rem; }
    .card p { margin: 0 0 14px; color: #94a3b8; }
    .toolbar { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; margin-bottom: 12px; }
    .filter-grid { display: grid; gap: 10px; grid-template-columns: 2fr 1fr 1fr 1fr; margin-bottom: 12px; }
    .filter-actions { display: grid; gap: 10px; grid-template-columns: repeat(5, minmax(0, 1fr)); }
    input, button, select { font: inherit; }
    input, select { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
    button { padding: 10px 14px; border: 0; border-radius: 10px; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; cursor: pointer; }
    button.secondary { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; min-height: 120px; overflow: auto; }
    .list { display: grid; gap: 10px; }
    .item { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 12px 14px; }
    .item-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    .item-title strong { font-size: 0.96rem; }
    .muted { color: #94a3b8; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 9px; font-size: 0.78rem; background: #172033; color: #cbd5e1; }
    .pill.open, .pill.active { background: rgba(37, 99, 235, 0.2); color: #93c5fd; }
    .pill.in-progress, .pill.superseded { background: rgba(245, 158, 11, 0.16); color: #fcd34d; }
    .pill.done { background: rgba(16, 185, 129, 0.18); color: #86efac; }
    .pill.cancelled, .pill.rejected { background: rgba(239, 68, 68, 0.16); color: #fca5a5; }
    .split { display: grid; gap: 18px; grid-template-columns: 1fr 1fr; }
    .mini-stats { display: grid; gap: 10px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 12px; }
    .mini-stat { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 10px 12px; }
    .mini-stat strong { display: block; font-size: 1.1rem; margin-top: 4px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    @media (max-width: 900px) { .stats, .split { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 900px) { .filter-grid, .filter-actions, .mini-stats { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 640px) { .stats, .split, .toolbar, .filter-grid, .filter-actions, .mini-stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div class="eyebrow">Free Local Dashboard</div>
      <h1>MemCode Local Dashboard</h1>
      <p>The claude-mem-inspired part is already here: progressive local memory capture, recent AI session continuity, and an always-on local worker. This dashboard makes those local features much more visible for open source users without moving hosted retrieval or sync out of Pro.</p>
      <p class="meta">Project: ${escapeHtml(projectPath)} · Port: ${port}</p>
    </div>
    <div class="stats" id="stats">
      <div class="stat"><div class="label">Open Tasks</div><div class="value" id="stat-open-tasks">-</div></div>
      <div class="stat"><div class="label">Active Decisions</div><div class="value" id="stat-active-decisions">-</div></div>
      <div class="stat"><div class="label">Checkpoints</div><div class="value" id="stat-checkpoints">-</div></div>
      <div class="stat"><div class="label">Imported Sessions</div><div class="value" id="stat-sessions">-</div></div>
    </div>
    <div class="grid">
      <div class="stack">
        <div class="card">
          <h2>Saved Dashboard Filters</h2>
          <p>Keep local dashboard views sticky per project and save presets in the browser for common workflows.</p>
          <div class="filter-grid">
            <input id="filter-query" placeholder="Search tasks, decisions, checkpoints..." />
            <select id="filter-task-status">
              <option value="open">Open tasks</option>
              <option value="in-progress">In-progress tasks</option>
              <option value="done">Done tasks</option>
              <option value="cancelled">Cancelled tasks</option>
              <option value="all">All tasks</option>
            </select>
            <select id="filter-decision-status">
              <option value="active">Active decisions</option>
              <option value="superseded">Superseded decisions</option>
              <option value="rejected">Rejected decisions</option>
              <option value="all">All decisions</option>
            </select>
            <select id="filter-activity-days">
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
          <div class="filter-actions">
            <button id="apply-filters">Apply filters</button>
            <button id="save-filter" class="secondary">Save current</button>
            <select id="saved-filters">
              <option value="">Saved filters</option>
            </select>
            <button id="apply-saved-filter" class="secondary">Use saved</button>
            <button id="delete-saved-filter" class="secondary">Delete saved</button>
          </div>
        </div>
        <div class="card">
          <h2>Recall Search</h2>
          <p>Search the local store with the current dashboard query.</p>
          <div class="toolbar">
            <input id="search-query-preview" placeholder="Search query comes from the filter bar above" disabled />
            <select id="search-limit">
              <option value="8">8 results</option>
              <option value="12">12 results</option>
              <option value="20">20 results</option>
            </select>
            <button id="search">Search</button>
          </div>
          <div class="list" id="results"><div class="item muted">Run a search to inspect local memory.</div></div>
        </div>
        <div class="split">
          <div class="card">
            <h2>Open Tasks</h2>
            <p>Browse local work without needing the CLI.</p>
            <div class="list" id="tasks"><div class="item muted">Loading...</div></div>
          </div>
          <div class="card">
            <h2>Active Decisions</h2>
            <p>Keep architectural context visible for new contributors.</p>
            <div class="list" id="decisions"><div class="item muted">Loading...</div></div>
          </div>
        </div>
        <div class="split">
          <div class="card">
            <h2>Recent Checkpoints</h2>
            <p>See recent project movement and commit snapshots.</p>
            <div class="list" id="checkpoints"><div class="item muted">Loading...</div></div>
          </div>
          <div class="card">
            <h2>Recent AI Sessions</h2>
            <p>Surface recent assistant activity before the next chat begins.</p>
            <div class="list" id="sessions"><div class="item muted">Loading...</div></div>
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <h2>Context Pack</h2>
          <p>Prompt-ready memory block for the next assistant session.</p>
          <pre id="context">Loading...</pre>
        </div>
        <div class="card">
          <h2>Timeline</h2>
          <p>Merged project history from checkpoints, decisions, and tasks.</p>
          <div class="list" id="timeline"><div class="item muted">Loading...</div></div>
        </div>
        <div class="card">
          <h2>Activity View</h2>
          <p>Simple local activity views over tasks, decisions, and checkpoints for the selected time window.</p>
          <div class="mini-stats" id="activity-totals">
            <div class="mini-stat"><span class="muted">Total</span><strong id="activity-total-all">-</strong></div>
            <div class="mini-stat"><span class="muted">Tasks</span><strong id="activity-total-tasks">-</strong></div>
            <div class="mini-stat"><span class="muted">Decisions</span><strong id="activity-total-decisions">-</strong></div>
            <div class="mini-stat"><span class="muted">Checkpoints</span><strong id="activity-total-checkpoints">-</strong></div>
          </div>
          <div class="list" id="activity"><div class="item muted">Loading...</div></div>
        </div>
        <div class="card">
          <h2>Health</h2>
          <p>Local worker runtime status and refresh details.</p>
          <pre id="health">Loading...</pre>
        </div>
      </div>
    </div>
  </div>
  <script>
    const FILTER_STORAGE_KEY = ${filterStorageKey};
    const CURRENT_FILTER_STORAGE_KEY = ${currentFilterStorageKey};
    const DEFAULT_FILTERS = {
      query: '',
      taskStatus: 'open',
      decisionStatus: 'active',
      activityDays: '14',
    };
    let currentFilters = { ...DEFAULT_FILTERS };

    function formatDate(value) {
      return new Date(value).toLocaleString();
    }
    function formatDay(value) {
      return new Date(value + 'T00:00:00Z').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    }
    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function normalizeFilters(filters) {
      return {
        query: typeof filters?.query === 'string' ? filters.query : DEFAULT_FILTERS.query,
        taskStatus: typeof filters?.taskStatus === 'string' ? filters.taskStatus : DEFAULT_FILTERS.taskStatus,
        decisionStatus: typeof filters?.decisionStatus === 'string' ? filters.decisionStatus : DEFAULT_FILTERS.decisionStatus,
        activityDays: typeof filters?.activityDays === 'string' ? filters.activityDays : DEFAULT_FILTERS.activityDays,
      };
    }
    function readSavedFilters() {
      try {
        const raw = localStorage.getItem(FILTER_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    function writeSavedFilters(filters) {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    }
    function loadCurrentFilters() {
      try {
        const raw = localStorage.getItem(CURRENT_FILTER_STORAGE_KEY);
        return normalizeFilters(raw ? JSON.parse(raw) : DEFAULT_FILTERS);
      } catch {
        return { ...DEFAULT_FILTERS };
      }
    }
    function persistCurrentFilters(filters) {
      localStorage.setItem(CURRENT_FILTER_STORAGE_KEY, JSON.stringify(filters));
    }
    function writeFilterInputs(filters) {
      document.getElementById('filter-query').value = filters.query;
      document.getElementById('filter-task-status').value = filters.taskStatus;
      document.getElementById('filter-decision-status').value = filters.decisionStatus;
      document.getElementById('filter-activity-days').value = filters.activityDays;
      document.getElementById('search-query-preview').value = filters.query || 'No active search query';
    }
    function readFilterInputs() {
      return normalizeFilters({
        query: document.getElementById('filter-query').value.trim(),
        taskStatus: document.getElementById('filter-task-status').value,
        decisionStatus: document.getElementById('filter-decision-status').value,
        activityDays: document.getElementById('filter-activity-days').value,
      });
    }
    function refreshSavedFilterOptions(selectedName) {
      const select = document.getElementById('saved-filters');
      const filters = readSavedFilters();
      select.innerHTML = '<option value="">Saved filters</option>';
      for (const entry of filters) {
        const option = document.createElement('option');
        option.value = entry.name;
        option.textContent = entry.name;
        if (selectedName && selectedName === entry.name) option.selected = true;
        select.appendChild(option);
      }
    }
    function renderList(targetId, items, renderItem, emptyText) {
      const node = document.getElementById(targetId);
      node.innerHTML = '';
      if (!items.length) {
        node.innerHTML = '<div class="item muted">' + emptyText + '</div>';
        return;
      }
      for (const item of items) {
        const wrapper = document.createElement('div');
        wrapper.className = 'item';
        wrapper.innerHTML = renderItem(item);
        node.appendChild(wrapper);
      }
    }
    async function loadHealth() {
      const data = await fetch('/health').then(r => r.json());
      document.getElementById('health').textContent = JSON.stringify(data, null, 2);
    }
    async function loadDashboard() {
      const data = await fetch('/api/dashboard').then(r => r.json());
      document.getElementById('stat-open-tasks').textContent = data.taskCounts.open || 0;
      document.getElementById('stat-active-decisions').textContent = data.decisionCounts.active || 0;
      document.getElementById('stat-checkpoints').textContent = data.checkpointCount || 0;
      document.getElementById('stat-sessions').textContent = data.sessionCount || 0;
    }
    async function loadContext() {
      const data = await fetch('/api/context-pack').then(r => r.json());
      document.getElementById('context').textContent = data.contextPack;
    }
    async function loadTimeline() {
      const data = await fetch('/api/timeline?limit=12').then(r => r.json());
      renderList('timeline', data.entries, (item) =>
        '<div class="item-title"><strong>' + escapeHtml(item.title) + '</strong><span class="pill ' + escapeHtml(item.type) + '">' + escapeHtml(item.type) + '</span></div>' +
        '<div class="meta">' + formatDate(item.created_at) + (item.meta ? ' · ' + escapeHtml(item.meta) : '') + '</div>' +
        (item.detail ? '<div>' + escapeHtml(item.detail) + '</div>' : ''),
      'No timeline entries yet.');
    }
    async function loadTasks() {
      const query = currentFilters.query ? '&q=' + encodeURIComponent(currentFilters.query) : '';
      const data = await fetch('/api/tasks?status=' + encodeURIComponent(currentFilters.taskStatus) + '&limit=8' + query).then(r => r.json());
      renderList('tasks', data.tasks, (item) =>
        '<div class="item-title"><strong>' + escapeHtml(item.title) + '</strong><span class="pill ' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + (item.priority ? ' · ' + escapeHtml(item.priority) : '') + '</span></div>' +
        '<div class="meta">Updated ' + formatDate(item.updated_at) + '</div>' +
        (item.description ? '<div>' + escapeHtml(item.description) + '</div>' : ''),
      'No matching tasks found.');
    }
    async function loadDecisions() {
      const query = currentFilters.query ? '&q=' + encodeURIComponent(currentFilters.query) : '';
      const data = await fetch('/api/decisions?status=' + encodeURIComponent(currentFilters.decisionStatus) + '&limit=8' + query).then(r => r.json());
      renderList('decisions', data.decisions, (item) =>
        '<div class="item-title"><strong>' + escapeHtml(item.title) + '</strong><span class="pill ' + escapeHtml(item.status) + '">' + escapeHtml(item.status) + '</span></div>' +
        '<div class="meta">Updated ' + formatDate(item.updated_at) + '</div>' +
        '<div>' + escapeHtml(item.rationale) + '</div>' +
        (item.impact ? '<div class="muted">Impact: ' + escapeHtml(item.impact) + '</div>' : ''),
      'No matching decisions found.');
    }
    async function loadCheckpoints() {
      const query = currentFilters.query ? '&q=' + encodeURIComponent(currentFilters.query) : '';
      const data = await fetch('/api/checkpoints?limit=8' + query).then(r => r.json());
      renderList('checkpoints', data.checkpoints, (item) =>
        '<div class="item-title"><strong>' + escapeHtml(item.summary_short) + '</strong><span class="pill">' + escapeHtml(item.trigger) + '</span></div>' +
        '<div class="meta">' + formatDate(item.created_at) + (item.branch ? ' · ' + escapeHtml(item.branch) : '') + (item.git_sha ? ' @' + escapeHtml(String(item.git_sha).slice(0, 8)) : '') + '</div>' +
        (item.summary_long ? '<div>' + escapeHtml(item.summary_long) + '</div>' : ''),
      'No matching checkpoints found.');
    }
    async function loadSessions() {
      const data = await fetch('/api/recent-sessions?limit=6').then(r => r.json());
      renderList('sessions', data.sessions, (item) =>
        '<div class="item-title"><strong>' + escapeHtml(item.agent || item.editor || 'assistant session') + '</strong><span class="pill">' + escapeHtml(String(item.message_count || 0)) + ' messages</span></div>' +
        '<div class="meta">' + formatDate(item.last_message_at || item.started_at) + '</div>',
      'No imported sessions yet.');
    }
    async function loadActivity() {
      const data = await fetch('/api/activity?days=' + encodeURIComponent(currentFilters.activityDays)).then(r => r.json());
      document.getElementById('activity-total-all').textContent = data.totals.total || 0;
      document.getElementById('activity-total-tasks').textContent = data.totals.tasks || 0;
      document.getElementById('activity-total-decisions').textContent = data.totals.decisions || 0;
      document.getElementById('activity-total-checkpoints').textContent = data.totals.checkpoints || 0;
      renderList('activity', data.buckets.filter((item) => item.total > 0), (item) =>
        '<div class="item-title"><strong>' + escapeHtml(formatDay(item.day)) + '</strong><span class="pill">' + escapeHtml(String(item.total)) + ' events</span></div>' +
        '<div class="meta">Tasks ' + escapeHtml(String(item.tasks)) + ' · Decisions ' + escapeHtml(String(item.decisions)) + ' · Checkpoints ' + escapeHtml(String(item.checkpoints)) + '</div>',
      'No project activity in this window.');
    }
    async function runSearch() {
      const query = currentFilters.query.trim();
      if (!query) return;
      const limit = document.getElementById('search-limit').value;
      const data = await fetch('/api/recall?q=' + encodeURIComponent(query) + '&limit=' + encodeURIComponent(limit)).then(r => r.json());
      renderList('results', data.results, (item) =>
        '<div class="item-title"><strong>' + escapeHtml(item.title || item.type || 'result') + '</strong><span class="pill">' + escapeHtml(item.type || 'memory') + '</span></div>' +
        (item.preview ? '<div>' + escapeHtml(item.preview) + '</div>' : '') +
        (item.score ? '<div class="meta">Score: ' + escapeHtml(item.score) + '</div>' : ''),
      'No matching local memory found.');
    }
    async function applyFilters() {
      currentFilters = readFilterInputs();
      persistCurrentFilters(currentFilters);
      writeFilterInputs(currentFilters);
      await Promise.all([loadTasks(), loadDecisions(), loadCheckpoints(), loadActivity()]);
      if (currentFilters.query) {
        await runSearch();
      } else {
        renderList('results', [], () => '', 'Run a search to inspect local memory.');
      }
    }
    function saveCurrentFilter() {
      const name = window.prompt('Save current dashboard filters as:');
      if (!name) return;
      const savedFilters = readSavedFilters().filter((entry) => entry.name !== name);
      savedFilters.push({ name, filters: currentFilters });
      savedFilters.sort((left, right) => left.name.localeCompare(right.name));
      writeSavedFilters(savedFilters);
      refreshSavedFilterOptions(name);
    }
    async function applySavedFilter() {
      const selectedName = document.getElementById('saved-filters').value;
      if (!selectedName) return;
      const savedFilter = readSavedFilters().find((entry) => entry.name === selectedName);
      if (!savedFilter) return;
      currentFilters = normalizeFilters(savedFilter.filters);
      writeFilterInputs(currentFilters);
      await applyFilters();
    }
    function deleteSavedFilter() {
      const selectedName = document.getElementById('saved-filters').value;
      if (!selectedName) return;
      const remaining = readSavedFilters().filter((entry) => entry.name !== selectedName);
      writeSavedFilters(remaining);
      refreshSavedFilterOptions();
    }
    document.getElementById('search').addEventListener('click', runSearch);
    document.getElementById('apply-filters').addEventListener('click', () => { void applyFilters(); });
    document.getElementById('save-filter').addEventListener('click', saveCurrentFilter);
    document.getElementById('apply-saved-filter').addEventListener('click', () => { void applySavedFilter(); });
    document.getElementById('delete-saved-filter').addEventListener('click', deleteSavedFilter);
    document.getElementById('filter-query').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSearch();
    });
    currentFilters = loadCurrentFilters();
    writeFilterInputs(currentFilters);
    refreshSavedFilterOptions();
    loadDashboard();
    loadHealth();
    loadContext();
    loadTimeline();
    loadSessions();
    void applyFilters();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectPath: string,
  runtime: ServiceRuntime,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    text(res, 200, renderViewerHtml(port, projectPath), 'text/html; charset=utf-8');
    return;
  }

  if (method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      status: 'ok',
      projectPath,
      port,
      runtime,
      assistantFiles: configuredAgentFilePaths(projectPath),
    });
    return;
  }

  const db = openDb(join(projectPath, '.memory', 'memory.db'));
  try {
    const workspace = getOrCreateWorkspace(db, projectPath);

    if (method === 'GET' && url.pathname === '/api/dashboard') {
      json(res, 200, getDashboardSummary(db, workspace.id, runtime, projectPath));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/context-pack') {
      json(res, 200, {
        workspaceId: workspace.id,
        contextPack: generateContextPack(db, workspace.id),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/recall') {
      const query = (url.searchParams.get('q') ?? '').trim();
      if (!query) {
        json(res, 400, { error: 'Missing q query parameter' });
        return;
      }
      const limit = parseLimit(url, 8, 25);
      json(res, 200, {
        query,
        results: await recall(db, workspace.id, query, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/timeline') {
      const limit = parseLimit(url, 12, 50);
      json(res, 200, {
        entries: getTimeline(db, workspace.id, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/activity') {
      const days = parseDays(url, 14, 180);
      json(res, 200, getActivitySummary(db, workspace.id, days));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/tasks') {
      const limit = parseLimit(url, 8, 50);
      const status = (url.searchParams.get('status') ?? '').trim() || null;
      const query = parseQuery(url);
      json(res, 200, {
        tasks: getTaskRecords(db, workspace.id, status, query, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/decisions') {
      const limit = parseLimit(url, 8, 50);
      const status = (url.searchParams.get('status') ?? '').trim() || null;
      const query = parseQuery(url);
      json(res, 200, {
        decisions: getDecisionRecords(db, workspace.id, status, query, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/checkpoints') {
      const limit = parseLimit(url, 8, 50);
      const query = parseQuery(url);
      json(res, 200, {
        checkpoints: getCheckpointRecords(db, workspace.id, query, limit),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/recent-sessions') {
      const limit = parseLimit(url, 5, 20);
      const sessions = db.prepare(
        `SELECT s.id, s.agent, s.editor, s.started_at, s.ended_at,
                COUNT(m.id) AS message_count,
                MAX(m.created_at) AS last_message_at
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.workspace_id = ?
         GROUP BY s.id
         ORDER BY COALESCE(MAX(m.created_at), s.ended_at, s.started_at) DESC
         LIMIT ?`,
      ).all(workspace.id, limit) as Array<Record<string, unknown>>;
      json(res, 200, { sessions });
      return;
    }
  } finally {
    db.close();
  }

  json(res, 404, { error: 'Not found' });
}

serviceCommand
  .command('start')
  .description('Start the local MemCode memory service for this project')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .option('--port <port>', 'HTTP port to bind locally')
  .option('--interval <seconds>', 'Maintenance interval in seconds', '60')
  .action(async (options: { path?: string; port?: string; interval: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const port = Math.max(1024, Number.parseInt(options.port ?? '', 10) || defaultServicePort(projectPath));
    const intervalSeconds = Math.max(15, Number.parseInt(options.interval, 10) || 60);
    const existing = readServiceState(projectPath);

    if (existing && isProcessRunning(existing.pid)) {
      console.log(pc.green('✓'), `Local memory service already running (${existing.pid}).`);
      console.log(pc.dim(`  url: http://127.0.0.1:${existing.port}`));
      return;
    }

    await runMaintenance(projectPath);
    clearServiceState(projectPath);

    const child = spawn(
      process.execPath,
      [process.argv[1], 'service', 'daemon', '--path', projectPath, '--port', String(port), '--interval', String(intervalSeconds)],
      {
        cwd: projectPath,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    child.unref();

    const state: ServiceState = {
      pid: child.pid ?? 0,
      projectPath,
      port,
      intervalSeconds,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(serviceStatePath(projectPath), JSON.stringify(state, null, 2) + '\n', 'utf-8');

    console.log(pc.green('✓'), `Local memory service started (${state.pid}).`);
    console.log(pc.dim(`  url: http://127.0.0.1:${port}`));
    console.log(pc.dim(`  interval: ${intervalSeconds}s`));
  });

serviceCommand
  .command('stop')
  .description('Stop the local MemCode memory service for this project')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { path?: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const state = readServiceState(projectPath);
    if (!state) {
      console.log(pc.yellow('~'), 'Local memory service is not running.');
      return;
    }
    if (state.pid && isProcessRunning(state.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // best effort
      }
    }
    clearServiceState(projectPath);
    console.log(pc.green('✓'), 'Local memory service stopped.');
  });

serviceCommand
  .command('status')
  .description('Show status for the local MemCode memory service')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { path?: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const state = readServiceState(projectPath);
    const port = state?.port ?? defaultServicePort(projectPath);

    console.log(pc.bold('Local memory service'));
    console.log(`  Project:       ${pc.cyan(projectPath)}`);
    console.log(`  Assistant ctx: ${configuredAgentFilePaths(projectPath).length > 0 ? pc.green('configured') : pc.dim('not configured')}`);

    if (!state || !isProcessRunning(state.pid)) {
      if (state) clearServiceState(projectPath);
      console.log(`  Background:    ${pc.dim('stopped')}`);
      console.log(`  URL:           ${pc.dim(`http://127.0.0.1:${port}`)}`);
      return;
    }

    console.log(`  Background:    ${pc.green('running')} (${state.pid})`);
    console.log(`  URL:           ${pc.cyan(`http://127.0.0.1:${state.port}`)}`);
    console.log(`  Interval:      ${pc.cyan(String(state.intervalSeconds))}s`);

    try {
      const res = await fetch(`http://127.0.0.1:${state.port}/health`);
      if (res.ok) {
        const body = await res.json() as { runtime?: { lastTickAt?: string | null } };
        console.log(`  Health:        ${pc.green('ok')}`);
        if (body.runtime?.lastTickAt) {
          console.log(`  Last tick:     ${pc.cyan(new Date(body.runtime.lastTickAt).toLocaleString())}`);
        }
      } else {
        console.log(`  Health:        ${pc.yellow(`HTTP ${res.status}`)}`);
      }
    } catch {
      console.log(`  Health:        ${pc.yellow('unreachable')}`);
    }
  });

serviceCommand
  .command('daemon')
  .description('Internal local memory service worker')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .option('--port <port>', 'HTTP port to bind locally')
  .option('--interval <seconds>', 'Maintenance interval in seconds', '60')
  .action(async (options: { path?: string; port?: string; interval: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const port = Math.max(1024, Number.parseInt(options.port ?? '', 10) || defaultServicePort(projectPath));
    const intervalSeconds = Math.max(15, Number.parseInt(options.interval, 10) || 60);
    let runtime: ServiceRuntime = {
      workspaceId: '',
      workspaceName: '',
      lastTickAt: null,
      lastImportedSessions: 0,
      lastImportedMessages: 0,
      refreshedFiles: 0,
    };

    const tick = async () => {
      runtime = await runMaintenance(projectPath);
    };

    const server = createServer((req, res) => {
      void handleRequest(req, res, projectPath, runtime, port).catch((error: unknown) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    const shutdown = () => {
      clearServiceState(projectPath);
      server.close(() => process.exit(0));
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    server.listen(port, '127.0.0.1', async () => {
      await tick();
      setInterval(() => {
        void tick();
      }, intervalSeconds * 1000);
    });
  });