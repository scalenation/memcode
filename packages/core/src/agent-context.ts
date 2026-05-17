/**
 * Agent context writer — the "always-on" layer that keeps every coding agent
 * in sync with MemCode's knowledge base automatically.
 *
 * Strategy:
 *  - Generate a canonical context block from the DB (assumptions, tasks,
 *    recent runs, repo index, decisions).
 *  - Inject that block into every detected agent config file using
 *    <!-- memcode:start --> / <!-- memcode:end --> section markers.
 *  - Files we never destructively overwrite — only the marked section is
 *    replaced, so user content outside it is preserved.
 *
 * Supported agents (auto-detected by file/directory presence):
 *  - GitHub Copilot   → .github/copilot-instructions.md
 *  - Claude Code      → CLAUDE.md  (or .claude/CLAUDE.md)
 *  - Cursor           → .cursorrules  (or .cursor/rules/memcode.md)
 *  - Aider            → .aider.conf.yml  (read: .memcode-context.md)
 *  - Windsurf         → .windsurfrules
 *  - Generic          → .memcode-context.md  (always written)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Assumption, Task, Decision, RepoIndexEntry } from './schema';
import { generateContextPack } from './context-pack';
import { listAssumptions } from './assumptions';
import { listIndexEntries } from './repo-index';
import { listRuns } from './run';

const SECTION_START = '<!-- memcode:start -->';
const SECTION_END = '<!-- memcode:end -->';

// ── Context block generation ───────────────────────────────────────────────────

export function buildAgentContextBlock(db: DatabaseSync, workspaceId: string): string {
  const assumptions = listAssumptions(db, workspaceId);
  const tasks = db.prepare(
    `SELECT * FROM tasks WHERE workspace_id = ? AND status IN ('open','in-progress')
     ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC LIMIT 5`,
  ).all(workspaceId) as unknown as Task[];
  const decisions = db.prepare(
    `SELECT * FROM decisions WHERE workspace_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 5`,
  ).all(workspaceId) as unknown as Decision[];
  const recentRuns = listRuns(db, workspaceId).slice(0, 3);
  const indexEntries = listIndexEntries(db, workspaceId);

  const lines: string[] = [
    SECTION_START,
    `## MemCode — Project Memory`,
    `> Auto-generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Do not edit this section manually.`,
    '',
  ];

  // Assumptions / rules
  if (assumptions.length > 0) {
    lines.push('### Project Rules & Assumptions');
    for (const a of assumptions) {
      const badge = a.source === 'user' ? '👤' : a.source === 'agent' ? '🤖' : '🔧';
      lines.push(`- ${badge} **${a.key}**: ${a.value}`);
    }
    lines.push('');
  }

  // Active tasks
  if (tasks.length > 0) {
    lines.push('### Active Tasks');
    for (const t of tasks) {
      const prio = t.priority ? ` [${t.priority}]` : '';
      lines.push(`- [${t.status}]${prio} ${t.title}`);
    }
    lines.push('');
  }

  // Key decisions
  if (decisions.length > 0) {
    lines.push('### Key Decisions');
    for (const d of decisions) {
      lines.push(`- **${d.title}**${d.rationale ? ': ' + d.rationale : ''}`);
    }
    lines.push('');
  }

  // Recent agent runs
  if (recentRuns.length > 0) {
    lines.push('### Recent Agent Runs');
    for (const r of recentRuns) {
      const date = new Date(r.created_at).toISOString().slice(0, 10);
      lines.push(`- [${r.status}] ${r.title} (${date})`);
    }
    lines.push('');
  }

  // Repo index summary
  if (indexEntries.length > 0) {
    const byKind: Record<string, RepoIndexEntry[]> = {};
    for (const e of indexEntries) {
      (byKind[e.kind] ??= []).push(e);
    }
    lines.push('### Repo Index');
    for (const [kind, entries] of Object.entries(byKind)) {
      const names = entries.slice(0, 8).map(e => e.label).join(', ');
      const extra = entries.length > 8 ? ` +${entries.length - 8} more` : '';
      lines.push(`- **${kind}**: ${names}${extra}`);
    }
    lines.push('');
  }

  lines.push(SECTION_END);
  return lines.join('\n');
}

// ── File injection helpers ─────────────────────────────────────────────────────

function injectIntoFile(filePath: string, block: string, createIfMissing = true): boolean {
  let content = '';
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf-8');
  } else if (!createIfMissing) {
    return false;
  }

  const start = content.indexOf(SECTION_START);
  const end = content.indexOf(SECTION_END);

  if (start !== -1 && end !== -1) {
    // Replace existing section
    content = content.slice(0, start) + block + content.slice(end + SECTION_END.length);
  } else if (content.trim().length === 0) {
    // Empty file — write block directly
    content = block + '\n';
  } else {
    // Append to existing user content
    content = content.trimEnd() + '\n\n' + block + '\n';
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return true;
}

// ── Agent detection & writing ─────────────────────────────────────────────────

export interface AgentContextResult {
  written: string[];   // files successfully written
  skipped: string[];   // files that would overwrite non-MemCode content (dry run only)
}

/**
 * Detect which coding agents are present and write the MemCode context block
 * into each of their config files.
 *
 * @param projectPath - root of the project (where .git lives)
 * @param db          - MemCode database
 * @param workspaceId - workspace to read context from
 */
export function writeAgentContextFiles(
  db: DatabaseSync,
  workspaceId: string,
  projectPath: string,
): AgentContextResult {
  const block = buildAgentContextBlock(db, workspaceId);
  const written: string[] = [];

  // 1. Canonical file — always written
  const canonical = join(projectPath, '.memcode-context.md');
  injectIntoFile(canonical, block, true);
  written.push('.memcode-context.md');

  // 2. GitHub Copilot
  const ghDir = join(projectPath, '.github');
  const copilotInstructions = join(ghDir, 'copilot-instructions.md');
  if (existsSync(ghDir) || existsSync(join(projectPath, '.git'))) {
    if (injectIntoFile(copilotInstructions, block, true)) {
      written.push('.github/copilot-instructions.md');
    }
  }

  // 3. Claude Code — CLAUDE.md at root
  const claudeMd = join(projectPath, 'CLAUDE.md');
  if (existsSync(claudeMd) || existsSync(join(projectPath, '.claude'))) {
    injectIntoFile(claudeMd, block, true);
    written.push('CLAUDE.md');
  }

  // 4. Cursor — .cursorrules or .cursor/rules/
  const cursorRules = join(projectPath, '.cursorrules');
  const cursorDir = join(projectPath, '.cursor');
  if (existsSync(cursorRules)) {
    injectIntoFile(cursorRules, block, false);
    written.push('.cursorrules');
  } else if (existsSync(cursorDir)) {
    injectIntoFile(join(cursorDir, 'rules', 'memcode.md'), block, true);
    written.push('.cursor/rules/memcode.md');
  }

  // 5. Windsurf
  const windsurfRules = join(projectPath, '.windsurfrules');
  if (existsSync(windsurfRules)) {
    injectIntoFile(windsurfRules, block, false);
    written.push('.windsurfrules');
  }

  return { written, skipped: [] };
}

/**
 * Remove all MemCode sections from agent context files (used on uninstall).
 */
export function clearAgentContextFiles(projectPath: string): string[] {
  const targets = [
    join(projectPath, '.memcode-context.md'),
    join(projectPath, '.github', 'copilot-instructions.md'),
    join(projectPath, 'CLAUDE.md'),
    join(projectPath, '.cursorrules'),
    join(projectPath, '.cursor', 'rules', 'memcode.md'),
    join(projectPath, '.windsurfrules'),
  ];
  const cleared: string[] = [];
  for (const filePath of targets) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf-8');
    const start = content.indexOf(SECTION_START);
    const end = content.indexOf(SECTION_END);
    if (start === -1 || end === -1) continue;
    const updated = (content.slice(0, start) + content.slice(end + SECTION_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd();
    writeFileSync(filePath, updated + '\n', 'utf-8');
    cleared.push(filePath);
  }
  return cleared;
}
