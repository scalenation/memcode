/**
 * memory watch — background daemon that keeps agent context files fresh.
 *
 * Watches for file changes in the project, debounces, then:
 *   1. Re-indexes changed files in the repo index
 *   2. Regenerates all agent context files (Copilot, Claude, Cursor, etc.)
 *
 * Usage:
 *   memory watch start     Start the watcher daemon (detached)
 *   memory watch stop      Stop the running daemon
 *   memory watch status    Show daemon status
 *   memory watch run       Run in the foreground (useful for debugging)
 */

import { Command } from 'commander';
import { existsSync, writeFileSync, readFileSync, unlinkSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openDb, getOrCreateWorkspace, buildRepoIndex, writeAgentContextFiles } from '@memcode/core';
import { findProjectRoot, getDbPath, getMemoryDir, reconcileWorkspaceIdentity } from '../util';
import pc from 'picocolors';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.memory', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
const DEBOUNCE_MS = 1500;

export const watchCommand = new Command('watch')
  .description('Watch for project changes and auto-refresh agent context files');

watchCommand
  .command('start')
  .description('Start the watch daemon in the background')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((opts: { path?: string }) => {
    const projectPath = opts.path ?? findProjectRoot();
    const memoryDir = getMemoryDir(projectPath);
    const pidFile = join(memoryDir, 'watch.pid');

    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf-8').trim());
      try {
        process.kill(pid, 0); // check if alive
        console.log(pc.yellow('~'), `Watch daemon already running (PID ${pid})`);
        return;
      } catch {
        // stale PID — clean up
        unlinkSync(pidFile);
      }
    }

    const child = spawn(process.execPath, [process.argv[1], 'watch', 'run', '--path', projectPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    // Give it 200ms to write its PID file, then report
    setTimeout(() => {
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, 'utf-8').trim();
        console.log(pc.green('✓'), `Watch daemon started (PID ${pid})`);
      } else {
        console.log(pc.green('✓'), `Watch daemon started (PID ${child.pid})`);
      }
      console.log(`  Auto-refreshing agent context on file changes in: ${pc.cyan(projectPath)}`);
      console.log(`  Stop with: ${pc.cyan('memory watch stop')}`);
    }, 250);
  });

watchCommand
  .command('stop')
  .description('Stop the running watch daemon')
  .option('--path <path>', 'Project path')
  .action((opts: { path?: string }) => {
    const projectPath = opts.path ?? findProjectRoot();
    const pidFile = join(getMemoryDir(projectPath), 'watch.pid');

    if (!existsSync(pidFile)) {
      console.log(pc.yellow('~'), 'No watch daemon running.');
      return;
    }

    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    try {
      process.kill(pid, 'SIGTERM');
      unlinkSync(pidFile);
      console.log(pc.green('✓'), `Watch daemon stopped (was PID ${pid})`);
    } catch {
      unlinkSync(pidFile);
      console.log(pc.yellow('~'), 'Daemon was not running (PID file removed).');
    }
  });

watchCommand
  .command('status')
  .description('Show watch daemon status')
  .option('--path <path>', 'Project path')
  .action((opts: { path?: string }) => {
    const projectPath = opts.path ?? findProjectRoot();
    const pidFile = join(getMemoryDir(projectPath), 'watch.pid');

    if (!existsSync(pidFile)) {
      console.log(pc.dim('Watch daemon: not running'));
      console.log(`  Start with: ${pc.cyan('memory watch start')}`);
      return;
    }

    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    try {
      process.kill(pid, 0);
      console.log(pc.green('●'), `Watch daemon running  PID ${pc.bold(String(pid))}`);
      console.log(`  Watching: ${pc.cyan(projectPath)}`);
    } catch {
      console.log(pc.red('✗'), `Watch daemon not running (stale PID ${pid})`);
      console.log(`  Start with: ${pc.cyan('memory watch start')}`);
    }
  });

watchCommand
  .command('run')
  .description('Run the watcher in the foreground (Ctrl-C to stop)')
  .option('--path <path>', 'Project path')
  .action((opts: { path?: string }) => {
    const projectPath = opts.path ?? findProjectRoot();
    const memoryDir = getMemoryDir(projectPath);
    const dbPath = getDbPath(projectPath);
    const pidFile = join(memoryDir, 'watch.pid');

    // Write PID file so `watch stop` can kill us
    writeFileSync(pidFile, String(process.pid), 'utf-8');

    const cleanup = () => {
      try { if (existsSync(pidFile)) unlinkSync(pidFile); } catch {}
      process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    console.log(pc.green('●'), `MemCode watch running (PID ${process.pid}) — ${projectPath}`);

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const changedFiles = new Set<string>();

    const refresh = () => {
      const db = openDb(dbPath);
      try {
        const workspace = reconcileWorkspaceIdentity(db, projectPath, getOrCreateWorkspace(db, projectPath));
        const files = [...changedFiles];
        changedFiles.clear();

        // Re-index changed source files
        const sourceFiles = files.filter(f => !f.includes('.memory') && !f.endsWith('.md'));
        if (sourceFiles.length > 0) {
          try {
            buildRepoIndex(db, { workspaceId: workspace.id, projectPath });
          } catch {}
        }

        // Always regenerate agent context files
        const result = writeAgentContextFiles(db, workspace.id, projectPath);
        const timestamp = new Date().toISOString().slice(11, 19);
        console.log(`  [${timestamp}] Context refreshed → ${result.written.join(', ')}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(pc.red('!'), `Refresh error: ${msg}`);
      } finally {
        db.close();
      }
    };

    // Watch the project directory recursively using Node's built-in fs.watch
    try {
      fsWatch(projectPath, { recursive: true }, (_, filename) => {
        if (!filename) return;
        // Skip ignored directories
        const parts = filename.split('/');
        if (parts.some(p => IGNORED_DIRS.has(p))) return;

        changedFiles.add(filename);
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(refresh, DEBOUNCE_MS);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(pc.red('✗'), `Cannot watch directory: ${msg}`);
      process.exit(1);
    }
  });
