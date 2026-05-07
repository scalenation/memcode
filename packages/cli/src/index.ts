#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { initCommand } from './commands/init';
import { checkpointCommand } from './commands/checkpoint';
import { recallCommand } from './commands/recall';
import { contextPackCommand } from './commands/context-pack';
import { timelineCommand } from './commands/timeline';
import { decisionCommand } from './commands/decision';
import { taskCommand } from './commands/task';
import { syncCommand } from './commands/sync';
import { doctorCommand } from './commands/doctor';
import { loadProPlugin } from './pro-loader';

// Show welcome message on first ever run
const welcomedFlag = join(homedir(), '.config', 'memcode', '.welcomed');
if (!existsSync(welcomedFlag)) {
  try {
    mkdirSync(join(homedir(), '.config', 'memcode'), { recursive: true });
    writeFileSync(welcomedFlag, '');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./scripts/postinstall');
  } catch { /* non-fatal */ }
}

const program = new Command();

program
  .name('memory')
  .description('MemCode — local-first project memory for coding assistants')
  .version('1.0.0', '-v, --version', 'Print version');

// Load Pro providers before any command runs (no-op if @memcode/pro not installed)
program.hook('preAction', (_thisCommand, actionCommand) => {
  // Resolve workspace ID from the command context if available
  const workspaceId = (actionCommand as unknown as { _workspaceId?: string })._workspaceId ?? '';
  loadProPlugin(workspaceId);
});

program.addCommand(initCommand);
program.addCommand(checkpointCommand);
program.addCommand(recallCommand);
program.addCommand(contextPackCommand);
program.addCommand(timelineCommand);
program.addCommand(decisionCommand);
program.addCommand(taskCommand);
program.addCommand(syncCommand);
program.addCommand(doctorCommand);

// Friendly error on unknown command
program.on('command:*', () => {
  console.error(`Unknown command: ${program.args.join(' ')}`);
  console.error(`Run 'memory --help' for available commands.`);
  process.exit(1);
});

program.parse(process.argv);
