import { Command } from 'commander';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  openDb,
  getOrCreateWorkspace,
  installGitHooks,
} from '@memcode/core';
import { findProjectRoot, getDbPath, getMemoryDir } from '../util';
import pc from 'picocolors';

export const initCommand = new Command('init')
  .description('Initialize project memory in the current repository')
  .option('--hooks', 'Install git hooks for automatic checkpointing')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { hooks?: boolean; path?: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const memoryDir = getMemoryDir(projectPath);
    const dbPath = getDbPath(projectPath);

    console.log(pc.bold('Initializing MemCode…'));
    console.log(`  Project: ${pc.cyan(projectPath)}`);
    console.log('');

    // 1. Create .memory directory
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
      console.log(pc.green('✓'), 'Created .memory directory');
    } else {
      console.log(pc.yellow('~'), '.memory directory already exists');
    }

    // 2. Initialise SQLite database (runs migrations)
    const isNewDb = !existsSync(dbPath);
    const db = openDb(dbPath);
    const workspace = getOrCreateWorkspace(db, projectPath);

    if (isNewDb) {
      console.log(
        pc.green('✓'),
        `Initialized database — workspace id: ${pc.cyan(workspace.id.slice(0, 8) + '…')}`,
      );
    } else {
      console.log(pc.yellow('~'), 'Database already exists — migrations applied');
    }

    // 3. Write config.json
    const configPath = join(memoryDir, 'config.json');
    if (!existsSync(configPath)) {
      const config = {
        version: 1,
        workspaceId: workspace.id,
        cloudSync: { enabled: false },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      console.log(pc.green('✓'), 'Created .memory/config.json');
    }

    // 4. Update .gitignore
    const gitignorePath = join(projectPath, '.gitignore');
    const entries = '\n# MemCode local memory files\n.memory/memory.db\n.memory/events.jsonl\n.memory/sync-daemon.json\n';
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.memory/memory.db')) {
        appendFileSync(gitignorePath, entries, 'utf-8');
        console.log(pc.green('✓'), 'Updated .gitignore');
      }
    } else {
      writeFileSync(gitignorePath, entries.trimStart(), 'utf-8');
      console.log(pc.green('✓'), 'Created .gitignore');
    }

    // 5. Optionally install git hooks
    if (options.hooks) {
      try {
        const result = installGitHooks(projectPath);
        if (result.installed.length > 0) {
          console.log(pc.green('✓'), `Installed git hooks: ${result.installed.join(', ')}`);
        }
        if (result.skipped.length > 0) {
          console.log(pc.yellow('~'), `Skipped (already present): ${result.skipped.join(', ')}`);
        }
        for (const err of result.errors) {
          console.log(pc.red('✗'), `${err.hook}: ${err.message}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(pc.yellow('!'), `Could not install hooks: ${msg}`);
      }
    }

    db.close();

    console.log('');
    console.log(pc.bold(pc.green('Memory initialized!')));
    if (!options.hooks) {
      console.log(`  Tip: run ${pc.cyan('memory init --hooks')} to enable automatic checkpointing.`);
    }
    console.log(`  Next: ${pc.cyan('memory checkpoint --note "Initial setup"')}`);
    console.log(`  Cloud: ${pc.cyan('memory sync auth')} then ${pc.cyan('memory sync start')} for background sync.`);
    console.log(`  Then: ${pc.cyan('memory copilot setup')} to inject context into every VS Code Copilot chat automatically.`);
  });
