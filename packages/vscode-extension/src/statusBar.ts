import * as vscode from 'vscode';
import { openDb, getOrCreateWorkspace, listCheckpoints } from '@memcode/core';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

type StatusState = 'idle' | 'syncing' | 'error' | 'uninitialized';

export class MemCodeStatusBar {
  private readonly item: vscode.StatusBarItem;
  private state: StatusState = 'uninitialized';

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'memcode.createCheckpoint';
    this.item.tooltip = 'MemCode — click to create a checkpoint';
    this.item.show();
    context.subscriptions.push(this.item);
  }

  update(state: StatusState): void {
    this.state = state;
    switch (state) {
      case 'idle':
        this.item.text = '$(database) Memory';
        this.item.color = undefined;
        break;
      case 'syncing':
        this.item.text = '$(sync~spin) Memory';
        this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        break;
      case 'error':
        this.item.text = '$(warning) Memory';
        this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        break;
      case 'uninitialized':
        this.item.text = '$(database) Memory (init)';
        this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.item.command = 'memcode.refreshContext';
        break;
    }
  }

  /** Refresh the status bar with the latest checkpoint age. */
  refresh(): void {
    const projectPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!projectPath) {
      this.update('uninitialized');
      return;
    }

    const dbPath = join(projectPath, '.memory', 'memory.db');
    if (!existsSync(dbPath)) {
      this.update('uninitialized');
      return;
    }

    try {
      const db = openDb(dbPath);
      const workspace = getOrCreateWorkspace(db, projectPath);
      const checkpoints = listCheckpoints(db, workspace.id, 1);
      db.close();

      if (checkpoints.length === 0) {
        this.item.text = '$(database) Memory (no checkpoints)';
        this.item.tooltip = 'MemCode — click to create first checkpoint';
        this.item.color = undefined;
        return;
      }

      const last = checkpoints[0];
      const ageMs = Date.now() - last.created_at;
      const ageLabel = formatAge(ageMs);

      this.item.text = `$(database) Memory (${ageLabel})`;
      this.item.tooltip = `MemCode — last checkpoint ${ageLabel} ago: ${last.summary_short}`;
      this.item.color = undefined;
      this.state = 'idle';
    } catch {
      this.update('error');
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
