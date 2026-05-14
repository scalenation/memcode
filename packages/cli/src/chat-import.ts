import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { redact } from '@memcode/core';

interface TranscriptEvent {
  type?: string;
  id?: string;
  timestamp?: string;
  data?: {
    sessionId?: string;
    startTime?: string;
    producer?: string;
    copilotVersion?: string;
    vscodeVersion?: string;
    messageId?: string;
    content?: string;
    toolRequests?: Array<{ name?: string }>;
  };
}

export interface ChatImportResult {
  sessions: number;
  messages: number;
  files: number;
}

export function importChatHistory(
  db: DatabaseSync,
  workspaceId: string,
  projectPath: string,
): ChatImportResult {
  const result = { sessions: 0, messages: 0, files: 0 };
  const transcriptFiles = findTranscriptFiles(projectPath);

  for (const filePath of transcriptFiles) {
    const text = safeRead(filePath);
    if (!text || !looksRelatedToProject(text, projectPath)) continue;

    const events = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(parseEvent)
      .filter((event): event is TranscriptEvent => !!event);

    const start = events.find(event => event.type === 'session.start');
    const rawSessionId = start?.data?.sessionId ?? sessionIdFromFile(filePath);
    const sessionId = stableId('vscode-copilot-session', rawSessionId);
    const startedAt = toMillis(start?.data?.startTime ?? start?.timestamp) ?? fileMtime(filePath);
    const endedAt = events
      .map(event => toMillis(event.timestamp) ?? 0)
      .reduce((max, ts) => Math.max(max, ts), startedAt);
    const agent = [start?.data?.producer, start?.data?.copilotVersion]
      .filter(Boolean)
      .join(' ')
      || 'GitHub Copilot';
    const editor = start?.data?.vscodeVersion
      ? `VS Code ${start.data.vscodeVersion}`
      : 'VS Code';

    const existingSession = db
      .prepare('SELECT ended_at FROM sessions WHERE id = ?')
      .get(sessionId) as unknown as { ended_at: number | null } | undefined;
    if (!existingSession) {
      db.prepare(`
        INSERT INTO sessions (id, workspace_id, editor, agent, started_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, workspaceId, editor, agent, startedAt, endedAt);
      result.sessions++;
    } else if (endedAt > (existingSession.ended_at ?? 0)) {
      db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);
    }

    for (const event of events) {
      const role = event.type === 'user.message'
        ? 'user'
        : event.type === 'assistant.message'
          ? 'assistant'
          : null;
      if (!role) continue;

      const content = redact(messageContent(event));
      if (!content) continue;

      const messageId = stableId(
        'vscode-copilot-message',
        event.data?.messageId ?? event.id ?? `${filePath}:${event.timestamp}:${content}`,
      );
      const exists = db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId);
      if (exists) continue;

      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        sessionId,
        role,
        content,
        estimateTokens(content),
        toMillis(event.timestamp) ?? startedAt,
      );
      result.messages++;
    }

    result.files++;
  }

  return result;
}

function findTranscriptFiles(projectPath: string): string[] {
  const files = new Set<string>();
  const explicitLog = process.env.VSCODE_TARGET_SESSION_LOG;
  if (explicitLog) {
    const transcriptRoot = explicitLog.replace('/debug-logs/', '/transcripts/');
    collectJsonl(dirnameSafe(transcriptRoot), files);
  }

  const roots = [
    join(homedir(), '.config', 'Code', 'User', 'workspaceStorage'),
    join(homedir(), '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
    join(homedir(), '.config', 'Cursor', 'User', 'workspaceStorage'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const child of safeList(root)) {
      collectJsonl(join(root, child, 'GitHub.copilot-chat', 'transcripts'), files);
    }
  }

  return Array.from(files)
    .filter(file => file.endsWith('.jsonl'))
    .sort((a, b) => fileMtime(b) - fileMtime(a))
    .slice(0, 100);
}

function collectJsonl(dir: string, files: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const name of safeList(dir)) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) collectJsonl(path, files);
      else if (name.endsWith('.jsonl')) files.add(path);
    } catch {
      // ignore unreadable files
    }
  }
}

function looksRelatedToProject(text: string, projectPath: string): boolean {
  const projectName = basename(projectPath);
  return text.includes(projectPath) || (!!projectName && text.includes(projectName));
}

function parseEvent(line: string): TranscriptEvent | null {
  try {
    return JSON.parse(line) as TranscriptEvent;
  } catch {
    return null;
  }
}

function messageContent(event: TranscriptEvent): string {
  const content = event.data?.content?.trim();
  if (content) return content;
  const tools = event.data?.toolRequests
    ?.map(tool => tool.name)
    .filter(Boolean);
  return tools && tools.length > 0 ? `Tool requests: ${tools.join(', ')}` : '';
}

function stableId(prefix: string, input: string): string {
  return `${prefix}:${createHash('sha256').update(input).digest('hex').slice(0, 32)}`;
}

function sessionIdFromFile(path: string): string {
  return basename(path).replace(/\.jsonl$/, '');
}

function toMillis(value?: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function safeList(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function dirnameSafe(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : path;
}