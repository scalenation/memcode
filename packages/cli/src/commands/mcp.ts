/**
 * MCP Server — Model Context Protocol (JSON-RPC 2.0 over stdio).
 *
 * Usage:
 *   memory mcp [--path /project]
 *
 * Then configure your agent to connect:
 *   Claude Code:  .claude/settings.json  → mcpServers
 *   Cursor:       .cursor/mcp.json
 *   Windsurf:     .windsurf/mcp.json
 *
 * Tools exposed:
 *   get_project_state      Full snapshot: tasks, decisions, runs, assumptions
 *   get_context_snapshot   Returns CONTEXT_SNAPSHOT.md content (agent-readable)
 *   record_progress        Update current goal / blockers (creates/heartbeats session)
 *   create_checkpoint      Git stash + DB checkpoint
 *   list_tasks             Active tasks list
 *   get_assumptions        Current project rules / assumptions
 *   add_assumption         Upsert a project rule
 *   end_session            End the active agent session
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  openDb,
  getOrCreateWorkspace,
  buildSnapshot,
  writeSnapshot,
  listAssumptions,
  setAssumption,
  createCheckpointSync,
  startAgentSession,
  heartbeatSession,
  updateSessionGoal,
  endAgentSession,
  getActiveSession,
  reapStaleSessions,
} from '@memcode/core';
import { findProjectRoot, getMemoryDir, getDbPath } from '../util';

const SERVER_VERSION = '1.0.38';
const PROTOCOL_VERSION = '2024-11-05';

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_project_state',
    description: 'Returns the full project state: active tasks, key decisions, recent run, assumptions, and modified files. Call this at the start of every session to orient yourself.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_context_snapshot',
    description: 'Returns the human-readable CONTEXT_SNAPSHOT.md content as a string. Contains Goal / Progress / Blockers / Active Tasks in a compact format.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'record_progress',
    description: 'Update your current goal and optionally record a blocker. Creates or heartbeats an agent session. Call this whenever your goal changes or you hit a blocker.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you are working on right now' },
        blocker: { type: 'string', description: 'Optional: describe any blocker or issue you have hit' },
        files_changed: { type: 'array', items: { type: 'string' }, description: 'List of file paths modified so far' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'create_checkpoint',
    description: 'Creates a checkpoint (saves progress) with a brief note. Optionally stashes uncommitted changes for rollback. Always call this before a risky change.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Short summary of what you have done so far' },
        stash: { type: 'boolean', description: 'If true, git-stash changes so they can be rolled back later' },
      },
      required: ['note'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Returns active and in-progress tasks for the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in-progress', 'all'], description: 'Filter by status' },
      },
      required: [],
    },
  },
  {
    name: 'get_assumptions',
    description: 'Returns all active project assumptions / rules (e.g. always use pnpm, never edit generated files).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_assumption',
    description: 'Add or update a project assumption/rule. Use this to persist insights so future agents inherit them.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short identifier, e.g. "package_manager"' },
        value: { type: 'string', description: 'The rule, e.g. "always use pnpm, never npm or yarn"' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'end_session',
    description: 'Mark your working session as complete. Pass a summary of what was accomplished.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was accomplished this session' },
      },
      required: [],
    },
  },
];

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function respond(id: number | string | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function error(id: number | string | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function toolResult(content: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }],
  };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

type ToolHandler = (
  db: ReturnType<typeof openDb>,
  workspaceId: string,
  projectPath: string,
  memoryDir: string,
  sessionId: string | null,
  args: Record<string, unknown>,
) => unknown;

const handlers: Record<string, ToolHandler> = {
  get_project_state: (db, workspaceId, projectPath) => {
    const snap = buildSnapshot(db, workspaceId, projectPath);
    return snap;
  },

  get_context_snapshot: (_db, _workspaceId, _projectPath, memoryDir) => {
    const mdPath = join(memoryDir, 'CONTEXT_SNAPSHOT.md');
    if (existsSync(mdPath)) {
      return { content: readFileSync(mdPath, 'utf-8') };
    }
    return { content: '_(No snapshot available. Run `memory checkpoint` to generate one.)_' };
  },

  record_progress: (db, workspaceId, _projectPath, _memoryDir, sessionId, args) => {
    const goal = args['goal'] as string;
    const blocker = args['blocker'] as string | undefined;
    const files = args['files_changed'] as string[] | undefined;

    if (sessionId) {
      updateSessionGoal(db, sessionId, goal, blocker, files);
    } else {
      const session = getActiveSession(db, workspaceId);
      if (session) {
        updateSessionGoal(db, session.id, goal, blocker, files);
      }
    }
    return { ok: true, goal };
  },

  create_checkpoint: (db, workspaceId, projectPath, memoryDir, _sessionId, args) => {
    const note = args['note'] as string;
    const wantStash = args['stash'] as boolean | undefined;

    // Write snapshot first
    writeSnapshot(db, workspaceId, projectPath, memoryDir);

    // Create checkpoint record
    const cp = createCheckpointSync(db, { workspaceId, projectPath, trigger: 'agent', note });
    return { ok: true, checkpoint_id: cp.id, note };
  },

  list_tasks: (db, workspaceId, _projectPath, _memoryDir, _sessionId, args) => {
    const status = (args['status'] as string | undefined) ?? 'open';
    const statuses = status === 'all'
      ? ['open', 'in-progress', 'done', 'cancelled']
      : status === 'open'
        ? ['open', 'in-progress']
        : [status];
    const placeholders = statuses.map(() => '?').join(',');
    const tasks = db.prepare(
      `SELECT id, title, status, priority, description FROM tasks
       WHERE workspace_id = ? AND status IN (${placeholders})
       ORDER BY CASE status WHEN 'in-progress' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,
                CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
       LIMIT 20`,
    ).all(workspaceId, ...statuses);
    return { tasks };
  },

  get_assumptions: (db, workspaceId) => {
    const assumptions = listAssumptions(db, workspaceId);
    return { assumptions: assumptions.map(a => ({ key: a.key, value: a.value })) };
  },

  add_assumption: (db, workspaceId, _projectPath, _memoryDir, _sessionId, args) => {
    const key = args['key'] as string;
    const value = args['value'] as string;
    setAssumption(db, { workspaceId, key, value, source: 'agent' });
    return { ok: true, key, value };
  },

  end_session: (db, workspaceId, projectPath, memoryDir, sessionId, args) => {
    const summary = args['summary'] as string | undefined;
    // Write a final snapshot
    const snap = writeSnapshot(db, workspaceId, projectPath, memoryDir);
    const targetId = sessionId ?? getActiveSession(db, workspaceId)?.id;
    if (targetId) {
      endAgentSession(db, targetId, JSON.stringify(snap));
    }
    return { ok: true, summary: summary ?? 'Session ended.' };
  },
};

// ── Main MCP loop ─────────────────────────────────────────────────────────────

export const mcpCommand = new Command('mcp')
  .description('Start a local MCP (Model Context Protocol) server over stdio')
  .option('--path <path>', 'Project path')
  .option('--agent <name>', 'Agent name for session tracking (e.g. cursor, claude)')
  .action((opts: { path?: string; agent?: string }) => {
    const projectPath = opts.path ?? findProjectRoot();
    const memoryDir = getMemoryDir(projectPath);
    const dbPath = getDbPath(projectPath);

    const db = openDb(dbPath);
    const workspace = getOrCreateWorkspace(db, projectPath);
    reapStaleSessions(db, workspace.id);

    // Start an agent session
    const session = startAgentSession(db, {
      workspaceId: workspace.id,
      projectPath,
      agent: opts.agent ?? detectAgent(),
    });

    let activeSessionId: string | null = session.id;

    // Heartbeat every 30 seconds
    const heartbeatTimer = setInterval(() => {
      try {
        if (activeSessionId) heartbeatSession(db, activeSessionId);
      } catch {}
    }, 30_000);

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      if (activeSessionId) {
        try {
          endAgentSession(db, activeSessionId);
          activeSessionId = null;
        } catch {}
      }
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('disconnect', cleanup);

    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        error(null, -32700, 'Parse error');
        return;
      }

      const { id, method, params = {} } = msg;

      if (method === 'initialize') {
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'memcode', version: SERVER_VERSION },
        });
        return;
      }

      if (method === 'initialized') {
        // Notification — no response needed
        return;
      }

      if (method === 'tools/list') {
        respond(id, { tools: TOOLS });
        return;
      }

      if (method === 'tools/call') {
        const toolName = params['name'] as string;
        const toolArgs = (params['arguments'] ?? {}) as Record<string, unknown>;

        const handler = handlers[toolName];
        if (!handler) {
          error(id, -32601, `Unknown tool: ${toolName}`);
          return;
        }

        try {
          const freshDb = openDb(dbPath);
          const result = handler(freshDb, workspace.id, projectPath, memoryDir, activeSessionId, toolArgs);
          respond(id, toolResult(result));
        } catch (err) {
          error(id, -32000, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === 'ping') {
        respond(id, {});
        return;
      }

      // Unknown method
      error(id, -32601, `Method not found: ${method}`);
    });

    rl.on('close', cleanup);
  });

// ── Utility ───────────────────────────────────────────────────────────────────

function detectAgent(): string {
  // Best-effort detection from environment
  const term = process.env['TERM_PROGRAM'] ?? '';
  const parent = process.env['CURSOR_AGENT'] ?? process.env['WINDSURF_AGENT'] ?? '';
  if (parent) return parent.toLowerCase();
  if (term.toLowerCase().includes('cursor')) return 'cursor';
  if (process.env['CLAUDE_CODE']) return 'claude';
  if (process.env['COPILOT_AGENT_MODE']) return 'copilot';
  return 'unknown';
}
