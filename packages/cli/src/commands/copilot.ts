import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { generateContextPack } from '@memcode/core';
import { resolveProject, findProjectRoot } from '../util';
import { hydrateProjectContext } from '../context-hydration';
import pc from 'picocolors';

// ─── constants ───────────────────────────────────────────────────────────────

const MARKER_START = '<!-- memcode:start -->';
const MARKER_END = '<!-- memcode:end -->';

export type Agent = 'copilot' | 'claude' | 'all';

// ─── agent file paths ────────────────────────────────────────────────────────

function copilotFilePath(projectPath: string): string {
  return join(projectPath, '.github', 'copilot-instructions.md');
}

function claudeFilePath(projectPath: string): string {
  return join(projectPath, 'CLAUDE.md');
}

/** Resolve the list of file paths to operate on for a given agent selector. */
function agentFilePaths(projectPath: string, agent: Agent): string[] {
  if (agent === 'copilot') return [copilotFilePath(projectPath)];
  if (agent === 'claude') return [claudeFilePath(projectPath)];
  return [copilotFilePath(projectPath), claudeFilePath(projectPath)];
}

// ─── section writer ──────────────────────────────────────────────────────────

/**
 * Upsert the MemCode block inside any file, preserving surrounding content.
 */
function upsertSection(filePath: string, body: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const section = `${MARKER_START}\n${body}\n${MARKER_END}`;

  if (existsSync(filePath)) {
    let existing = readFileSync(filePath, 'utf-8');
    const si = existing.indexOf(MARKER_START);
    const ei = existing.indexOf(MARKER_END);
    if (si !== -1 && ei !== -1 && ei > si) {
      existing =
        existing.slice(0, si).trimEnd() +
        (si > 0 ? '\n\n' : '') +
        section +
        existing.slice(ei + MARKER_END.length).trimStart();
      if (!existing.endsWith('\n')) existing += '\n';
    } else {
      existing = existing.trimEnd() + '\n\n' + section + '\n';
    }
    writeFileSync(filePath, existing, 'utf-8');
  } else {
    writeFileSync(filePath, section + '\n', 'utf-8');
  }
}

function hasSection(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const c = readFileSync(filePath, 'utf-8');
  return c.includes(MARKER_START) && c.includes(MARKER_END);
}

// ─── public helpers (used by checkpoint.ts) ──────────────────────────────────

/**
 * The static instructions block injected above the dynamic context.
 * Tells the AI assistant how to interpret MemCode data.
 */
export function buildInstructionsHeader(projectName: string): string {
  return [
    `## MemCode — Project Memory (${projectName})`,
    '',
    '> Auto-managed by [MemCode CLI](https://github.com/scalenation/memcode).',
    '> Refreshes automatically on every `memory checkpoint`. Run `memory copilot refresh` to update manually.',
    '',
    '### How to use this memory',
    '- **Active Tasks** are the source of truth for current work — reference task IDs when implementing.',
    '- **Key Decisions** record architectural choices already made. Do not suggest reversals without a clear reason.',
    '- After significant changes suggest running: `memory checkpoint --note "<what you did>"`',
    '- Use `memory recall --query "<topic>"` to search past context semantically.',
    '- Use `memory task add --title "<task>"` to track new work items.',
    '- Use `memory decision add --title "<decision>" --rationale "<why>"` to record architectural choices.',
    '',
  ].join('\n');
}

/**
 * Write the MemCode context body to all agent files that are already configured.
 * Used by `memory checkpoint` for automatic refresh.
 */
export function writeMemcodeSection(projectPath: string, body: string): void {
  const files = [
    copilotFilePath(projectPath),
    claudeFilePath(projectPath),
  ];
  for (const f of files) {
    if (hasSection(f)) upsertSection(f, body);
  }
}

/**
 * Return true if any agent file already has a MemCode section.
 * Used by `memory checkpoint` to decide whether to auto-refresh.
 */
export function hasMemcodeSection(projectPath: string): boolean {
  return (
    hasSection(copilotFilePath(projectPath)) ||
    hasSection(claudeFilePath(projectPath))
  );
}

/** Return human-readable labels for which agent files are configured. */
function configuredAgents(projectPath: string): string[] {
  const labels: string[] = [];
  if (hasSection(copilotFilePath(projectPath))) labels.push('VS Code Copilot');
  if (hasSection(claudeFilePath(projectPath))) labels.push('Claude Code');
  return labels;
}

// ─── command ─────────────────────────────────────────────────────────────────

export const copilotCommand = new Command('copilot')
  .description(
    'Wire MemCode into AI coding assistants so every new chat automatically receives project context',
  );

// ─── copilot setup ───────────────────────────────────────────────────────────

copilotCommand
  .command('setup')
  .description(
    'Inject MemCode context into AI assistant config files so every chat session receives project memory automatically',
  )
  .option(
    '--agent <agent>',
    'Which assistant to configure: copilot | claude | all (default: all)',
    'all',
  )
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { agent: string; path?: string }) => {
    const agent = (options.agent || 'all') as Agent;
    const validAgents: Agent[] = ['copilot', 'claude', 'all'];
    if (!validAgents.includes(agent)) {
      console.error(pc.red('Invalid --agent value.'), `Use one of: ${validAgents.join(', ')}`);
      process.exit(1);
    }

    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace, projectPath } = project;
    const filePaths = agentFilePaths(projectPath, agent);

    try {
      hydrateProjectContext(db, workspace.id, projectPath);
      const contextPack = generateContextPack(db, workspace.id);
      const body = buildInstructionsHeader(workspace.name) + contextPack;

      const agentLabels: Record<string, string> = {
        [copilotFilePath(projectPath)]: 'VS Code Copilot  → .github/copilot-instructions.md',
        [claudeFilePath(projectPath)]:  'Claude Code      → CLAUDE.md',
      };

      for (const filePath of filePaths) {
        const wasUpdate = hasSection(filePath);
        upsertSection(filePath, body);
        console.log(pc.green('✓'), wasUpdate ? 'Updated' : 'Created', pc.bold(agentLabels[filePath] ?? filePath));
      }

      console.log('');
      console.log(pc.dim('These files are read automatically by the AI assistant at the start of every chat.'));
      console.log(pc.dim('The context section refreshes automatically after each `memory checkpoint`.'));
      console.log('');
      console.log('Next steps:');
      if (filePaths.includes(copilotFilePath(projectPath))) {
        console.log(`  • Commit ${pc.cyan('.github/copilot-instructions.md')} so teammates share Copilot context, or gitignore it for personal use.`);
      }
      if (filePaths.includes(claudeFilePath(projectPath))) {
        console.log(`  • Commit ${pc.cyan('CLAUDE.md')} so teammates share Claude Code context, or gitignore it for personal use.`);
      }
      console.log(`  • Run ${pc.cyan('memory copilot refresh')} any time to pull in the latest memory.`);
    } finally {
      db.close();
    }
  });

// ─── copilot refresh ─────────────────────────────────────────────────────────

copilotCommand
  .command('refresh')
  .description(
    'Refresh the MemCode section in all configured AI assistant files from current memory state',
  )
  .option(
    '--agent <agent>',
    'Which assistant file(s) to refresh: copilot | claude | all (default: all configured)',
  )
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .option('--quiet', 'Suppress output (used by automatic refresh)')
  .action((options: { agent?: string; path?: string; quiet?: boolean }) => {
    if (options.agent) {
      const validAgents: Agent[] = ['copilot', 'claude', 'all'];
      if (!validAgents.includes(options.agent as Agent)) {
        console.error(pc.red('Invalid --agent value.'), `Use one of: ${validAgents.join(', ')}`);
        process.exit(1);
      }
    }

    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      if (!options.quiet) {
        console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      }
      process.exit(1);
    }

    const { db, workspace, projectPath } = project;

    // If --agent not specified, refresh whichever files are already configured
    const filesToRefresh: string[] = [];
    if (options.agent) {
      const agent = options.agent as Agent;
      for (const f of agentFilePaths(projectPath, agent)) {
        if (hasSection(f)) filesToRefresh.push(f);
      }
    } else {
      for (const f of agentFilePaths(projectPath, 'all')) {
        if (hasSection(f)) filesToRefresh.push(f);
      }
    }

    if (filesToRefresh.length === 0) {
      if (!options.quiet) {
        console.log(pc.yellow('!'), 'MemCode is not yet wired into any AI assistant for this project.');
        console.log(`  Run ${pc.cyan('memory copilot setup')} first.`);
      }
      db.close();
      return;
    }

    try {
      hydrateProjectContext(db, workspace.id, projectPath);
      const contextPack = generateContextPack(db, workspace.id);
      const body = buildInstructionsHeader(workspace.name) + contextPack;
      for (const f of filesToRefresh) {
        upsertSection(f, body);
        if (!options.quiet) console.log(pc.green('✓'), 'Refreshed', pc.bold(f.replace(projectPath + '/', '')));
      }
    } finally {
      db.close();
    }
  });

// ─── copilot status ──────────────────────────────────────────────────────────

copilotCommand
  .command('status')
  .description('Show which AI assistants have MemCode context wired for this project')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { path?: string }) => {
    const projectPath = options.path ?? findProjectRoot();

    const checks: Array<{ label: string; filePath: string }> = [
      { label: 'VS Code Copilot', filePath: copilotFilePath(projectPath) },
      { label: 'Claude Code',     filePath: claudeFilePath(projectPath) },
    ];

    let anyActive = false;
    for (const { label, filePath } of checks) {
      const relPath = filePath.replace(projectPath + '/', '');
      if (!existsSync(filePath)) {
        console.log(pc.dim('○'), pc.bold(label), pc.dim(`(${relPath} — not created)`));
        continue;
      }
      const content = readFileSync(filePath, 'utf-8');
      if (!content.includes(MARKER_START) || !content.includes(MARKER_END)) {
        console.log(pc.yellow('~'), pc.bold(label), pc.dim(`(${relPath} — file exists, MemCode section missing)`));
        continue;
      }

      const si = content.indexOf(MARKER_START);
      const ei = content.indexOf(MARKER_END);
      const section = content.slice(si + MARKER_START.length, ei).trim();
      const generatedMatch = section.match(/Generated (\S+)/);
      const generatedAt = generatedMatch ? new Date(generatedMatch[1]).toLocaleString() : 'unknown';

      console.log(pc.green('✓'), pc.bold(label));
      console.log(`    File      : ${pc.cyan(relPath)}`);
      console.log(`    Generated : ${generatedAt}`);
      console.log(`    Size      : ${section.length.toLocaleString()} chars`);
      anyActive = true;
    }

    console.log('');
    if (anyActive) {
      console.log(pc.dim('Context auto-refreshes after each `memory checkpoint`.'));
      console.log(pc.dim('Run `memory copilot refresh` to update manually.'));
    } else {
      console.log(`Run ${pc.cyan('memory copilot setup')} to enable automatic context injection.`);
    }
  });


