#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { checkpointCommand } from './commands/checkpoint';
import { recallCommand } from './commands/recall';
import { contextPackCommand } from './commands/context-pack';
import { timelineCommand } from './commands/timeline';
import { decisionCommand } from './commands/decision';
import { taskCommand } from './commands/task';
import { syncCommand } from './commands/sync';
import { doctorCommand } from './commands/doctor';

const program = new Command();

program
  .name('memory')
  .description('MemCode — local-first project memory for coding assistants')
  .version('1.0.0', '-v, --version', 'Print version');

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
