import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveProject, findProjectRoot } from '../util';
import {
  type Agent,
  agentFilePaths,
  agentLabel,
  claudeFilePath,
  copilotFilePath,
  hasManagedSection,
  hasMemcodeSection,
  upsertManagedSection,
  writeMemcodeSection,
} from '../assistant-adapters';
import {
  buildAssistantContextBody,
  buildInstructionsHeader,
} from '../assistant-context';
import pc from 'picocolors';

export { buildInstructionsHeader } from '../assistant-context';
export { hasMemcodeSection, writeMemcodeSection } from '../assistant-adapters';

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
      const { body } = buildAssistantContextBody(db, workspace, projectPath);

      for (const filePath of filePaths) {
        const wasUpdate = hasManagedSection(filePath);
        upsertManagedSection(filePath, body);
        console.log(pc.green('✓'), wasUpdate ? 'Updated' : 'Created', pc.bold(agentLabel(filePath, projectPath)));
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
        if (hasManagedSection(f)) filesToRefresh.push(f);
      }
    } else {
      for (const f of agentFilePaths(projectPath, 'all')) {
        if (hasManagedSection(f)) filesToRefresh.push(f);
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
      const { body } = buildAssistantContextBody(db, workspace, projectPath);
      for (const f of filesToRefresh) {
        upsertManagedSection(f, body);
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
      if (!hasManagedSection(filePath)) {
        console.log(pc.yellow('~'), pc.bold(label), pc.dim(`(${relPath} — file exists, MemCode section missing)`));
        continue;
      }

      const startMarker = '<!-- memcode:start -->';
      const endMarker = '<!-- memcode:end -->';
      const si = content.indexOf(startMarker);
      const ei = content.indexOf(endMarker);
      const section = content.slice(si + startMarker.length, ei).trim();
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


