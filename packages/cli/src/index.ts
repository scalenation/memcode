#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkgVersion: string = (require('../package.json') as { version: string }).version;

const program = new Command();

type CommandLoader = () => Promise<Command>;

const COMMAND_LOADERS: Record<string, CommandLoader> = {
  init: async () => (await import('./commands/init')).initCommand,
  checkpoint: async () => (await import('./commands/checkpoint')).checkpointCommand,
  recall: async () => (await import('./commands/recall')).recallCommand,
  timeline: async () => (await import('./commands/timeline')).timelineCommand,
  decision: async () => (await import('./commands/decision')).decisionCommand,
  task: async () => (await import('./commands/task')).taskCommand,
  sync: async () => (await import('./commands/sync')).syncCommand,
  service: async () => (await import('./commands/service')).serviceCommand,
  doctor: async () => (await import('./commands/doctor')).doctorCommand,
  // ── Orchestration ────────────────────────────────────────────────────────────
  run: async () => (await import('./commands/run')).runCommand,
  assume: async () => (await import('./commands/assume')).assumeCommand,
  index: async () => (await import('./commands/index-cmd')).indexCommand,
  eval: async () => (await import('./commands/eval')).evalCommand,
  // ── Auto-context ─────────────────────────────────────────────────────────────
  watch: async () => (await import('./commands/watch')).watchCommand,
  context: async () => (await import('./commands/context')).contextCommand,
  // ── MCP Server ───────────────────────────────────────────────────────────────
  mcp: async () => (await import('./commands/mcp')).mcpCommand,
};

program
  .name('memory')
  .description('MemCode — local-first project memory for coding assistants')
  .version(pkgVersion, '-v, --version', 'Print version');

// Load Pro providers before any command runs (no-op if @memcode/pro not installed)
program.hook('preAction', (_thisCommand, actionCommand) => {
  // Resolve workspace ID from the command context if available
  const workspaceId = (actionCommand as unknown as { _workspaceId?: string })._workspaceId ?? '';
  loadProPlugin(workspaceId);
});

// Friendly error on unknown command
program.on('command:*', () => {
  console.error(`Unknown command: ${program.args.join(' ')}`);
  console.error(`Run 'memory --help' for available commands.`);
  process.exit(1);
});

async function registerCommands(): Promise<void> {
  const requested = process.argv[2];
  const loadAll = !requested || requested.startsWith('-') || requested === 'help';

  if (loadAll) {
    const commands = await Promise.all(Object.values(COMMAND_LOADERS).map((load) => load()));
    for (const command of commands) {
      program.addCommand(command);
    }
    return;
  }

  const loader = COMMAND_LOADERS[requested];
  if (loader) {
    program.addCommand(await loader());
  }
}

async function main(): Promise<void> {
  await registerCommands();
  await program.parseAsync(process.argv);
}

void main();
