#!/usr/bin/env node
import pc from 'picocolors';

// Skip welcome message in CI environments or when npm is running internally
if (process.env.CI || process.env.npm_config_yes === 'true') {
  process.exit(0);
}

const lines = [
  '',
  pc.bold(pc.cyan('  ╔╦╗╔═╗╔╦╗╔═╗╔═╗╔╦╗╔═╗')),
  pc.bold(pc.cyan('  ║║║║╣ ║║║║  ║ ║ ║║║╣ ')),
  pc.bold(pc.cyan('  ╩ ╩╚═╝╩ ╩╚═╝╚═╝═╩╝╚═╝')),
  '',
  pc.bold('  MemCode — Local-first project memory for coding assistants'),
  pc.dim('  v' + (process.env.npm_package_version ?? '?')),
  '',
  pc.green('  ✓') + '  ' + pc.white('Free forever') + pc.dim(' — all local, no telemetry, no server required'),
  pc.green('  ✓') + '  ' + pc.white('Works with any AI assistant') + pc.dim(' (Claude, GPT, Gemini, Copilot)'),
  pc.green('  ✓') + '  ' + pc.white('Git-native') + pc.dim(' — hooks auto-checkpoint on every commit'),
  '',
  pc.bold('  ──────────────────────────────────────────────────'),
  pc.bold('  Quick start'),
  pc.bold('  ──────────────────────────────────────────────────'),
  '',
  '  ' + pc.cyan('memory init') + '              Initialize memory in this project',
  '  ' + pc.cyan('memory init --hooks') + '      Initialize + install git hooks',
  '  ' + pc.cyan('memory checkpoint') + '        Save current state manually',
  '  ' + pc.cyan('memory recall <query>') + '    Search your memory',
  '  ' + pc.cyan('memory context-pack') + '      Print AI-ready context block',
  '  ' + pc.cyan('memory doctor') + '            Check your setup',
  '  ' + pc.cyan('memory --help') + '            Full command reference',
  '',
  pc.bold('  ──────────────────────────────────────────────────'),
  '',
  '  ' + pc.dim('Docs:  https://github.com/scalenation/memcode'),
  '  ' + pc.dim('Pro:   https://memcode.dev/pro') + pc.dim('  (LLM summaries · semantic recall · team sync)'),
  '',
];

process.stdout.write(lines.join('\n') + '\n');
