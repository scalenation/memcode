import { Command } from 'commander';
import { generateContextPack } from '@memcode/core';
import { resolveProject } from '../util';
import { hydrateProjectContext } from '../context-hydration';
import pc from 'picocolors';

export const contextPackCommand = new Command('context-pack')
  .description('Generate a compact context block for use in a new chat session')
  .option('--copy', 'Copy the output to the clipboard (requires xclip/pbcopy)')
  .option('--output <file>', 'Write to a file instead of stdout')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { copy?: boolean; output?: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace, projectPath } = project;

    try {
      hydrateProjectContext(db, workspace.id, projectPath);
      const pack = generateContextPack(db, workspace.id);

      if (options.output) {
        const { writeFileSync } = require('node:fs') as typeof import('node:fs');
        writeFileSync(options.output, pack, 'utf-8');
        console.error(pc.green('✓'), `Context pack written to ${options.output}`);
        return;
      }

      if (options.copy) {
        const { execSync } = require('node:child_process') as typeof import('node:child_process');
        const platform = process.platform;
        const cmd = platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
        try {
          execSync(cmd, { input: pack });
          console.error(pc.green('✓'), 'Context pack copied to clipboard');
          return;
        } catch {
          console.error(pc.yellow('!'), 'Could not copy to clipboard — printing to stdout');
        }
      }

      // Default: print to stdout so the user can pipe it wherever they need
      process.stdout.write(pack + '\n');
    } finally {
      db.close();
    }
  });
