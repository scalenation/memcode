import * as vscode from 'vscode';
import { openDb, getOrCreateWorkspace, createCheckpoint } from '@memcode/core';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { MemCodeStatusBar } from './statusBar';

const SAVE_DEBOUNCE_MS = 30_000; // 30 seconds

export function setupWatchers(
  context: vscode.ExtensionContext,
  statusBar: MemCodeStatusBar,
  channel: vscode.OutputChannel,
): void {
  // ── On-save debounce watcher ──────────────────────────────────────────
  const config = vscode.workspace.getConfiguration('memcode');
  const autoOnSave: boolean = config.get('autoCheckpointOnSave', false);

  if (autoOnSave) {
    let saveTimer: ReturnType<typeof setTimeout> | undefined;

    const saveDisposable = vscode.workspace.onDidSaveTextDocument(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        triggerCheckpoint('on-save', statusBar, channel);
      }, SAVE_DEBOUNCE_MS);
    });

    context.subscriptions.push(saveDisposable);
  }

  // ── SCM post-commit watcher ───────────────────────────────────────────
  // VS Code doesn't expose a direct post-commit event; we watch the git
  // HEAD ref file to detect new commits.
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (projectPath) {
    const headPath = join(projectPath, '.git', 'COMMIT_EDITMSG');
    if (existsSync(join(projectPath, '.git'))) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(join(projectPath, '.git'), 'COMMIT_EDITMSG'),
      );

      watcher.onDidChange(() => {
        channel.appendLine('MemCode: detected commit, creating checkpoint…');
        triggerCheckpoint('post-commit', statusBar, channel);
      });

      context.subscriptions.push(watcher);

      // Branch switch: watch HEAD file
      const headWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(join(projectPath, '.git'), 'HEAD'),
      );

      let lastHead = readHead(projectPath);
      headWatcher.onDidChange(() => {
        const currentHead = readHead(projectPath);
        if (currentHead !== lastHead) {
          lastHead = currentHead;
          channel.appendLine(`MemCode: branch switch detected → ${currentHead}`);
          triggerCheckpoint('branch-switch', statusBar, channel);
        }
      });

      context.subscriptions.push(headWatcher);
    }
  }

  // Refresh status bar every 5 minutes
  const intervalId = setInterval(() => statusBar.refresh(), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(intervalId) });
}

function readHead(projectPath: string): string {
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(join(projectPath, '.git', 'HEAD'), 'utf-8').trim();
  } catch {
    return '';
  }
}

function triggerCheckpoint(
  trigger: string,
  statusBar: MemCodeStatusBar,
  channel: vscode.OutputChannel,
): void {
  const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectPath) return;

  const dbPath = join(projectPath, '.memory', 'memory.db');
  if (!existsSync(dbPath)) return;

  try {
    statusBar.update('syncing');
    const db = openDb(dbPath);
    const workspace = getOrCreateWorkspace(db, projectPath);
    const cp = createCheckpoint(db, {
      workspaceId: workspace.id,
      projectPath,
      trigger,
    });
    db.close();
    statusBar.refresh();
    channel.appendLine(`Checkpoint [${trigger}]: ${cp.summary_short}`);
  } catch (err: unknown) {
    statusBar.update('error');
    channel.appendLine(
      `MemCode checkpoint error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
