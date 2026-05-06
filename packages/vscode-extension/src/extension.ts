import * as vscode from 'vscode';
import { MemCodeStatusBar } from './statusBar';
import { registerCommands } from './commands';
import { setupWatchers } from './watchers';

let statusBar: MemCodeStatusBar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('MemCode');
  channel.appendLine('MemCode extension activating…');

  // Status bar
  statusBar = new MemCodeStatusBar(context);
  statusBar.update('idle');

  // Register palette commands
  registerCommands(context, statusBar, channel);

  // Background watchers (save debounce, SCM events, branch change)
  setupWatchers(context, statusBar, channel);

  // Initial refresh
  statusBar.refresh();

  channel.appendLine('MemCode ready.');
}

export function deactivate(): void {
  statusBar?.dispose();
}
