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

function renderViewerHtml(port: number, projectPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MemCode Local Service</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1020; color: #edf2f7; }
    .page { max-width: 1080px; margin: 0 auto; padding: 32px 20px 48px; }
    .hero { display: grid; gap: 8px; margin-bottom: 28px; }
    .hero h1 { margin: 0; font-size: 1.8rem; }
    .hero p { margin: 0; color: #a0aec0; }
    .grid { display: grid; gap: 18px; grid-template-columns: 1.1fr 0.9fr; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 18px; }
    .card h2 { margin: 0 0 12px; font-size: 1rem; }
    .meta { font-size: 0.88rem; color: #94a3b8; }
    input, button, textarea { font: inherit; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
    button { padding: 10px 14px; border: 0; border-radius: 10px; background: #2563eb; color: white; cursor: pointer; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 14px; min-height: 120px; overflow: auto; }
    ul { margin: 0; padding-left: 18px; }
    li { margin-bottom: 10px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <h1>MemCode Local Service</h1>
      <p>Always-on local memory worker for assistant context refresh, recall, and timeline browsing.</p>
      <p class="meta">Project: ${escapeHtml(projectPath)} · Port: ${port}</p>
    </div>
    <div class="grid">
      <div class="card">
        <h2>Recall</h2>
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:12px;">
          <input id="query" placeholder="Search memory, decisions, checkpoints, tasks..." />
          <button id="search">Search</button>
        </div>
        <pre id="results">Run a search to inspect local memory.</pre>
      </div>
      <div class="card">
        <h2>Context Pack</h2>
        <pre id="context">Loading...</pre>
      </div>
      <div class="card">
        <h2>Timeline</h2>
        <ul id="timeline"><li>Loading...</li></ul>
      </div>
      <div class="card">
        <h2>Health</h2>
        <pre id="health">Loading...</pre>
      </div>
    </div>
  </div>
  <script>
    async function loadHealth() {
      const data = await fetch('/health').then(r => r.json());
      document.getElementById('health').textContent = JSON.stringify(data, null, 2);
    }
    async function loadContext() {
      const data = await fetch('/api/context-pack').then(r => r.json());
      document.getElementById('context').textContent = data.contextPack;
    }
    async function loadTimeline() {
      const data = await fetch('/api/timeline?limit=12').then(r => r.json());
      const list = document.getElementById('timeline');
      list.innerHTML = '';
      for (const item of data.entries) {
        const li = document.createElement('li');
        li.innerHTML = '<strong>' + item.title + '</strong><div class="meta">' + item.type + ' · ' + new Date(item.created_at).toLocaleString() + '</div>' + (item.detail ? '<div>' + item.detail + '</div>' : '');
        list.appendChild(li);
      }
      if (!data.entries.length) list.innerHTML = '<li>No timeline entries yet.</li>';
    }
    async function runSearch() {
      const query = document.getElementById('query').value.trim();
      if (!query) return;
      const data = await fetch('/api/recall?q=' + encodeURIComponent(query) + '&limit=8').then(r => r.json());
      document.getElementById('results').textContent = JSON.stringify(data.results, null, 2);
    }
    document.getElementById('search').addEventListener('click', runSearch);
    document.getElementById('query').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSearch();
    });
    loadHealth();
    loadContext();
    loadTimeline();
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