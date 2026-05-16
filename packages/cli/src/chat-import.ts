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
  data?: Record<string, unknown> & {
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
    const firstPrompt = firstUserPrompt(events);
    const telemetry = extractSessionTelemetry(events, start, firstPrompt);

    const existingSession = db
      .prepare('SELECT ended_at FROM sessions WHERE id = ?')
      .get(sessionId) as unknown as { ended_at: number | null } | undefined;
    if (!existingSession) {
      db.prepare(`
        INSERT INTO sessions (id, workspace_id, editor, agent, source, provider, model, task_label, category, started_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        workspaceId,
        editor,
        agent,
        telemetry.source,
        telemetry.provider,
        telemetry.model,
        telemetry.taskLabel,
        telemetry.category,
        startedAt,
        endedAt,
      );
      result.sessions++;
    } else {
      const nextEndedAt = Math.max(endedAt, existingSession.ended_at ?? 0);
      db.prepare(`
        UPDATE sessions
        SET ended_at = ?,
            source = COALESCE(source, ?),
            provider = COALESCE(provider, ?),
            model = COALESCE(model, ?),
            task_label = COALESCE(task_label, ?),
            category = COALESCE(category, ?)
        WHERE id = ?
      `).run(
        nextEndedAt || null,
        telemetry.source,
        telemetry.provider,
        telemetry.model,
        telemetry.taskLabel,
        telemetry.category,
        sessionId,
      );
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

function firstUserPrompt(events: TranscriptEvent[]): string {
  for (const event of events) {
    if (event.type !== 'user.message') continue;
    const content = messageContent(event);
    if (content) return content;
  }
  return '';
}

function extractSessionTelemetry(
  events: TranscriptEvent[],
  start: TranscriptEvent | undefined,
  firstPrompt: string,
): {
  source: string | null;
  provider: string | null;
  model: string | null;
  taskLabel: string | null;
  category: 'decision' | 'bugfix' | 'feature' | 'discovery';
} {
  const source = normalizeString(start?.data?.producer) ?? 'github-copilot-chat';
  const model = findMetadataString(events, ['modelId', 'model', 'chatModel', 'engine', 'deploymentModel']);
  const provider = findMetadataString(events, ['provider', 'vendor']) ?? inferProviderFromModel(model);
  return {
    source,
    provider,
    model,
    taskLabel: summarizeTaskLabel(firstPrompt),
    category: inferSessionCategory(firstPrompt),
  };
}

function findMetadataString(events: TranscriptEvent[], keys: string[]): string | null {
  for (const event of events) {
    const value = findStringByKeys(event.data, keys, 0);
    if (value) return value;
  }
  return null;
}

function findStringByKeys(value: unknown, keys: string[], depth: number): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findStringByKeys(item, keys, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.includes(key) && typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }
    const nested = findStringByKeys(entry, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function inferProviderFromModel(model: string | null): string | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.includes('gpt') || normalized.includes('o1') || normalized.includes('o3') || normalized.includes('o4')) {
    return 'OpenAI';
  }
  if (normalized.includes('claude')) return 'Anthropic';
  if (normalized.includes('gemini')) return 'Google';
  return null;
}

function summarizeTaskLabel(content: string): string | null {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117).trimEnd()}...`;
}

function inferSessionCategory(content: string): 'decision' | 'bugfix' | 'feature' | 'discovery' {
  const normalized = content.toLowerCase();
  if (/(bug|fix|error|issue|broken|crash|debug|regression|failing|failure)/.test(normalized)) {
    return 'bugfix';
  }
  if (/(decision|decide|choose|tradeoff|trade-off|architecture|architectural|design|should we|which approach)/.test(normalized)) {
    return 'decision';
  }
  if (/(feature|add|implement|create|build|support|enable|dashboard|page|workflow)/.test(normalized)) {
    return 'feature';
  }
  return 'discovery';
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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