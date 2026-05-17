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
  buildRepoIndex,
  writeAgentContextFiles,
} from '@memcode/core';
import { findProjectRoot, getDbPath, getMemoryDir, reconcileWorkspaceIdentity } from '../util';
import pc from 'picocolors';

export const initCommand = new Command('init')
  .description('Initialize MemCode — scans repo, installs hooks, injects context into all coding agents')
  .option('--no-hooks', 'Skip git hook installation')
  .option('--no-context', 'Skip writing agent context files')
  .option('--no-index', 'Skip initial repo index scan')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { hooks?: boolean; context?: boolean; index?: boolean; path?: string }) => {
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
    const workspace = reconcileWorkspaceIdentity(db, projectPath, getOrCreateWorkspace(db, projectPath));

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
        version: 2,
        workspaceId: workspace.id,
        workspaceStrategy: 'manual',
        cloudSync: { enabled: false },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      console.log(pc.green('✓'), 'Created .memory/config.json');
    }

    // 4. Update .gitignore
    const gitignorePath = join(projectPath, '.gitignore');
    const entries = '\n# MemCode local memory files\n.memory/memory.db\n.memory/events.jsonl\n.memory/sync-daemon.json\n.memory/watch.pid\n';
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

    // 5. Scan repo index
    if (options.index !== false) {
      try {
        const result = buildRepoIndex(db, { workspaceId: workspace.id, projectPath });
        const total = result.components + result.endpoints + result.tests + result.modules;
        console.log(pc.green('✓'), `Repo index built — ${total} entries (${result.duration_ms}ms)`);        
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(pc.yellow('!'), `Repo index scan skipped: ${msg}`);
      }
    }

    // 6. Install git hooks (default: yes)
    if (options.hooks !== false) {
      try {
        const result = installGitHooks(projectPath);
        if (result.installed.length > 0) {
          console.log(pc.green('✓'), `Git hooks installed: ${result.installed.join(', ')}`);
        }
        if (result.skipped.length > 0) {
          console.log(pc.yellow('~'), `Hooks already present: ${result.skipped.join(', ')}`);
        }
        for (const err of result.errors) {
          console.log(pc.red('✗'), `${err.hook}: ${err.message}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(pc.yellow('!'), `Could not install hooks: ${msg}`);
      }
    }

    // 7. Write agent context files (inject into Copilot, Claude, Cursor, etc.)
    if (options.context !== false) {
      try {
        const result = writeAgentContextFiles(db, workspace.id, projectPath);
        if (result.written.length > 0) {
          console.log(pc.green('✓'), `Context injected into: ${result.written.join(', ')}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(pc.yellow('!'), `Context file write skipped: ${msg}`);
      }
    }

    db.close();

    console.log('');
    console.log(pc.bold(pc.green('MemCode is ready!')));
    console.log('');
    console.log('  Your coding agents now have full project context.');
    console.log(`  Keep it fresh:  ${pc.cyan('memory watch start')}  — auto-updates on every file change`);
    console.log(`  Cloud sync:     ${pc.cyan('memory sync auth')}  then  ${pc.cyan('memory sync start')}  (Pro)`);
    console.log(`  Checkpoint:     ${pc.cyan('memory checkpoint --note "description"')}  — snapshot current state`);
    console.log('');
    console.log(`  Context is written to your agent config files automatically.`);
    console.log(`  Run ${pc.cyan('memory context refresh')} any time to force-update all agent files.`);
  });
