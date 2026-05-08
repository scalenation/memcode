import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { generateContextPack } from '@memcode/core';
import { resolveProject, findProjectRoot } from '../util';
import pc from 'picocolors';

// ─── helpers ─────────────────────────────────────────────────────────────────

const MARKER_START = '<!-- memcode:start -->';
const MARKER_END = '<!-- memcode:end -->';

/**
 * The static instructions injected once, above the dynamic context block.
 * Tells Copilot how to interpret and use MemCode data.
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
 * Write (or update) the MemCode section inside `.github/copilot-instructions.md`.
 * Preserves any content outside the MemCode markers.
 */
export function writeMemcodeSection(projectPath: string, body: string): void {
  const githubDir = join(projectPath, '.github');
  const instructionsPath = join(githubDir, 'copilot-instructions.md');

  mkdirSync(githubDir, { recursive: true });

  const section = `${MARKER_START}\n${body}\n${MARKER_END}`;

  if (existsSync(instructionsPath)) {
    let existing = readFileSync(instructionsPath, 'utf-8');
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Replace existing MemCode section, preserve everything else
      existing =
        existing.slice(0, startIdx).trimEnd() +
        (startIdx > 0 ? '\n\n' : '') +
        section +
        existing.slice(endIdx + MARKER_END.length).trimStart();
      if (!existing.endsWith('\n')) existing += '\n';
    } else {
      // Append to the end of the existing file
      existing = existing.trimEnd() + '\n\n' + section + '\n';
    }
    writeFileSync(instructionsPath, existing, 'utf-8');
  } else {
    writeFileSync(instructionsPath, section + '\n', 'utf-8');
  }
}

/**
 * Check whether the project currently has a MemCode section in copilot-instructions.md.
 */
export function hasMemcodeSection(projectPath: string): boolean {
  const instructionsPath = join(projectPath, '.github', 'copilot-instructions.md');
  if (!existsSync(instructionsPath)) return false;
  const content = readFileSync(instructionsPath, 'utf-8');
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

// ─── command ─────────────────────────────────────────────────────────────────

export const copilotCommand = new Command('copilot')
  .description(
    'Wire MemCode into VS Code Copilot so every new chat automatically receives project context',
  );

// ─── copilot setup ───────────────────────────────────────────────────────────

copilotCommand
  .command('setup')
  .description(
    'Inject MemCode context into .github/copilot-instructions.md — VS Code Copilot reads this on every chat',
  )
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace, projectPath } = project;
    const instructionsPath = join(projectPath, '.github', 'copilot-instructions.md');
    const isUpdate = hasMemcodeSection(projectPath);

    try {
      const contextPack = generateContextPack(db, workspace.id);
      const body = buildInstructionsHeader(workspace.name) + contextPack;
      writeMemcodeSection(projectPath, body);

      console.log(
        pc.green('✓'),
        isUpdate ? 'Updated' : 'Created',
        pc.bold(instructionsPath),
      );
      console.log('');
      console.log(pc.dim('VS Code Copilot reads this file automatically on every chat session.'));
      console.log(pc.dim('The context updates automatically after each `memory checkpoint`.'));
      console.log('');
      console.log('Next steps:');
      console.log(`  1. ${pc.dim('Add to .gitignore if you prefer not to commit it:')}  echo ".github/copilot-instructions.md" >> .gitignore`);
      console.log(`  2. ${pc.dim('Or commit it')} so teammates share the same Copilot context automatically.`);
      console.log(`  3. Run ${pc.cyan('memory copilot refresh')} any time to pull in the latest memory.`);
    } finally {
      db.close();
    }
  });

// ─── copilot refresh ─────────────────────────────────────────────────────────

copilotCommand
  .command('refresh')
  .description(
    'Refresh the MemCode section in .github/copilot-instructions.md from current memory state',
  )
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .option('--quiet', 'Suppress output (used by automatic refresh)')
  .action((options: { path?: string; quiet?: boolean }) => {
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
    const instructionsPath = join(projectPath, '.github', 'copilot-instructions.md');

    if (!hasMemcodeSection(projectPath)) {
      if (!options.quiet) {
        console.log(pc.yellow('!'), 'MemCode is not yet wired into VS Code Copilot for this project.');
        console.log(`  Run ${pc.cyan('memory copilot setup')} first.`);
      }
      db.close();
      return;
    }

    try {
      const contextPack = generateContextPack(db, workspace.id);
      const body = buildInstructionsHeader(workspace.name) + contextPack;
      writeMemcodeSection(projectPath, body);
      if (!options.quiet) {
        console.log(pc.green('✓'), 'Refreshed', pc.bold(instructionsPath));
      }
    } finally {
      db.close();
    }
  });

// ─── copilot status ──────────────────────────────────────────────────────────

copilotCommand
  .command('status')
  .description('Show whether MemCode is wired into VS Code Copilot for this project')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { path?: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const instructionsPath = join(projectPath, '.github', 'copilot-instructions.md');

    if (!existsSync(instructionsPath)) {
      console.log(pc.yellow('○'), pc.bold('Not configured'));
      console.log(`  ${pc.dim(instructionsPath)} does not exist.`);
      console.log(`  Run ${pc.cyan('memory copilot setup')} to enable automatic Copilot context injection.`);
      return;
    }

    const content = readFileSync(instructionsPath, 'utf-8');
    const hasSection = content.includes(MARKER_START) && content.includes(MARKER_END);

    if (!hasSection) {
      console.log(pc.yellow('○'), pc.bold('File exists but MemCode section is missing'));
      console.log(`  ${pc.dim(instructionsPath)}`);
      console.log(`  Run ${pc.cyan('memory copilot setup')} to inject the MemCode section.`);
      return;
    }

    // Extract section dates/metadata from content
    const startIdx = content.indexOf(MARKER_START);
    const endIdx = content.indexOf(MARKER_END);
    const section = content.slice(startIdx + MARKER_START.length, endIdx).trim();
    const generatedMatch = section.match(/Generated (\S+)/);
    const generatedAt = generatedMatch ? new Date(generatedMatch[1]).toLocaleString() : 'unknown';

    console.log(pc.green('✓'), pc.bold('MemCode context is active'));
    console.log(`  File       : ${pc.cyan(instructionsPath)}`);
    console.log(`  Generated  : ${generatedAt}`);
    console.log(`  Characters : ${section.length.toLocaleString()}`);
    console.log('');
    console.log(pc.dim('VS Code Copilot reads this file automatically on every chat session.'));
    console.log(pc.dim('Context auto-refreshes after each `memory checkpoint`.'));
  });
