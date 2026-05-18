/**
 * memory context — manage agent context files
 *
 *   memory context refresh     Regenerate context files for all detected agents
 *   memory context show        Print the current context block to stdout
 *   memory context clear       Remove MemCode sections from all agent files
 */

import { Command } from 'commander';
import {
  buildRepoIndex,
  writeAgentContextFiles,
  buildAgentContextBlock,
  clearAgentContextFiles,
} from '@memcode/core';
import { resolveProject } from '../util';
import pc from 'picocolors';

export const contextCommand = new Command('context')
  .description('Manage agent context files (Copilot, Claude, Cursor, etc.)');

contextCommand
  .command('refresh')
  .description('Regenerate context files for all detected coding agents')
  .option('--path <path>', 'Project path')
  .option('--rescan', 'Re-scan repo index before refreshing')
  .action((opts: { path?: string; rescan?: boolean }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }

    const { db, workspace, projectPath } = project;
    try {
      if (opts.rescan) {
        const r = buildRepoIndex(db, { workspaceId: workspace.id, projectPath });
        const total = r.components + r.endpoints + r.tests + r.modules;
        console.log(pc.green('✓'), `Repo index refreshed — ${total} entries`);
      }

      const result = writeAgentContextFiles(db, workspace.id, projectPath);
      console.log(pc.green('✓'), `Context written to:`);
      for (const f of result.written) {
        console.log(`    ${pc.cyan(f)}`);
      }
    } finally {
      db.close();
    }
  });

contextCommand
  .command('show')
  .description('Print the current context block that will be injected into agent files')
  .option('--path <path>', 'Project path')
  .action((opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }

    const { db, workspace } = project;
    try {
      console.log(buildAgentContextBlock(db, workspace.id));
    } finally {
      db.close();
    }
  });

contextCommand
  .command('clear')
  .description('Remove MemCode sections from all agent config files')
  .option('--path <path>', 'Project path')
  .action((opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }

    const { projectPath } = project;
    project.db.close();

    const cleared = clearAgentContextFiles(projectPath);
    if (cleared.length === 0) {
      console.log(pc.dim('No MemCode sections found in agent files.'));
    } else {
      console.log(pc.green('✓'), `Removed MemCode sections from:`);
      for (const f of cleared) console.log(`    ${pc.cyan(f)}`);
    }
  });

contextCommand
  .command('pack')
  .description('Generate a compact context block for use in a new chat session')
  .option('--copy', 'Copy the output to the clipboard (requires xclip/pbcopy)')
  .option('--output <file>', 'Write to a file instead of stdout')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((opts: { copy?: boolean; output?: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }

    const { db, workspace } = project;
    // Import lazily to avoid loading generateContextPack at startup
    const { generateContextPack } = require('@memcode/core') as typeof import('@memcode/core');

    try {
      const pack = generateContextPack(db, workspace.id);

      if (opts.output) {
        const { writeFileSync } = require('node:fs') as typeof import('node:fs');
        writeFileSync(opts.output, pack, 'utf-8');
        console.error(pc.green('✓'), `Context pack written to ${opts.output}`);
        return;
      }

      if (opts.copy) {
        const { execSync } = require('node:child_process') as typeof import('node:child_process');
        const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
        try {
          execSync(cmd, { input: pack });
          console.error(pc.green('✓'), 'Context pack copied to clipboard');
          return;
        } catch {
          console.error(pc.yellow('!'), 'Could not copy to clipboard — printing to stdout');
        }
      }

      process.stdout.write(pack + '\n');
    } finally {
      db.close();
    }
  });
