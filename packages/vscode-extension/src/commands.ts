import * as vscode from 'vscode';
import {
  openDb,
  getOrCreateWorkspace,
  createCheckpoint,
  recall,
  generateContextPack,
  getTimeline,
  createDecision,
  createTask,
} from '@memcode/core';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { MemCodeStatusBar } from './statusBar';

/**
 * Return the absolute path to the first workspace folder, or undefined.
 */
function getProjectPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Open the MemCode database for the current VS Code workspace.
 * Returns undefined (with a user-visible message) if not initialised.
 */
function openProjectDb(projectPath: string) {
  const dbPath = join(projectPath, '.memory', 'memory.db');
  if (!existsSync(dbPath)) {
    vscode.window.showErrorMessage(
      "MemCode: No database found. Run 'memory init' in a terminal first.",
    );
    return undefined;
  }
  try {
    return openDb(dbPath);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `MemCode: Could not open database — ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export function registerCommands(
  context: vscode.ExtensionContext,
  statusBar: MemCodeStatusBar,
  channel: vscode.OutputChannel,
): void {
  const reg = (id: string, fn: () => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ── Memory: Refresh Context ─────────────────────────────────────────
  reg('memcode.refreshContext', async () => {
    statusBar.update('syncing');
    await statusBar.refresh();
    statusBar.update('idle');
    vscode.window.showInformationMessage('MemCode context refreshed.');
  });

  // ── Memory: Create Checkpoint ───────────────────────────────────────
  reg('memcode.createCheckpoint', async () => {
    const projectPath = getProjectPath();
    if (!projectPath) return;

    const note = await vscode.window.showInputBox({
      prompt: 'Checkpoint note (optional)',
      placeHolder: 'e.g. Finished auth module',
    });

    const db = openProjectDb(projectPath);
    if (!db) return;

    try {
      const workspace = getOrCreateWorkspace(db, projectPath);
      const cp = await createCheckpoint(db, {
        workspaceId: workspace.id,
        projectPath,
        trigger: 'manual',
        note: note || undefined,
      });
      statusBar.update('idle');
      statusBar.refresh();
      channel.appendLine(`Checkpoint created: ${cp.id} — ${cp.summary_short}`);
      vscode.window.showInformationMessage(`MemCode checkpoint: ${cp.summary_short}`);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `MemCode: Checkpoint failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      db.close();
    }
  });

  // ── Memory: Show Timeline ───────────────────────────────────────────
  reg('memcode.showTimeline', async () => {
    const projectPath = getProjectPath();
    if (!projectPath) return;

    const db = openProjectDb(projectPath);
    if (!db) return;

    try {
      const workspace = getOrCreateWorkspace(db, projectPath);
      const entries = getTimeline(db, workspace.id, 50);

      if (entries.length === 0) {
        vscode.window.showInformationMessage('MemCode: No timeline entries yet.');
        return;
      }

      const items = entries.map((e) => ({
        label: `$(${e.type === 'checkpoint' ? 'git-commit' : e.type === 'decision' ? 'bookmark' : 'tasklist'}) ${e.title}`,
        description: new Date(e.created_at).toLocaleDateString(),
        detail: e.detail?.slice(0, 120),
      }));

      await vscode.window.showQuickPick(items, {
        title: 'MemCode Timeline',
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } finally {
      db.close();
    }
  });

  // ── Memory: Recall ──────────────────────────────────────────────────
  reg('memcode.recall', async () => {
    const projectPath = getProjectPath();
    if (!projectPath) return;

    const query = await vscode.window.showInputBox({
      prompt: 'Recall query',
      placeHolder: 'e.g. database choice',
    });
    if (!query) return;

    const db = openProjectDb(projectPath);
    if (!db) return;

    try {
      const workspace = getOrCreateWorkspace(db, projectPath);
      const results = await recall(db, workspace.id, query, 10);

      if (results.length === 0) {
        vscode.window.showInformationMessage(`MemCode: No results for "${query}"`);
        return;
      }

      const items = results.map((r) => ({
        label: `$(${r.type === 'decision' ? 'bookmark' : r.type === 'task' ? 'tasklist' : 'git-commit'}) ${r.title}`,
        description: r.type,
        detail: r.reason,
      }));

      await vscode.window.showQuickPick(items, {
        title: `Recall: "${query}"`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } finally {
      db.close();
    }
  });

  // ── Memory: Add Decision ────────────────────────────────────────────
  reg('memcode.addDecision', async () => {
    const projectPath = getProjectPath();
    if (!projectPath) return;

    const title = await vscode.window.showInputBox({
      prompt: 'Decision title',
      placeHolder: 'e.g. Use PostgreSQL for main store',
    });
    if (!title) return;

    const rationale = await vscode.window.showInputBox({
      prompt: 'Rationale / reasoning',
      placeHolder: 'e.g. Better concurrency support than SQLite at scale',
    });
    if (!rationale) return;

    const impact = await vscode.window.showInputBox({
      prompt: 'Impact (optional)',
      placeHolder: 'e.g. All services must use the pg driver',
    });

    const db = openProjectDb(projectPath);
    if (!db) return;

    try {
      const workspace = getOrCreateWorkspace(db, projectPath);
      createDecision(db, {
        workspaceId: workspace.id,
        title,
        rationale,
        impact: impact || undefined,
      });
      vscode.window.showInformationMessage(`MemCode: Decision recorded — "${title}"`);
      channel.appendLine(`Decision added: ${title}`);
    } finally {
      db.close();
    }
  });

  // ── Memory: Add Task ────────────────────────────────────────────────
  reg('memcode.addTask', async () => {
    const projectPath = getProjectPath();
    if (!projectPath) return;

    const title = await vscode.window.showInputBox({
      prompt: 'Task title',
      placeHolder: 'e.g. Implement OAuth refresh token rotation',
    });
    if (!title) return;

    const priority = await vscode.window.showQuickPick(['high', 'medium', 'low'], {
      title: 'Priority',
      placeHolder: 'Select priority',
    });

    const db = openProjectDb(projectPath);
    if (!db) return;

    try {
      const workspace = getOrCreateWorkspace(db, projectPath);
      createTask(db, {
        workspaceId: workspace.id,
        title,
        priority: (priority as 'high' | 'medium' | 'low') ?? 'medium',
      });
      vscode.window.showInformationMessage(`MemCode: Task created — "${title}"`);
      channel.appendLine(`Task added: ${title}`);
    } finally {
      db.close();
    }
  });

  // ── Memory: Inject Context Into Chat ───────────────────────────────
  reg('memcode.injectContextIntoChat', async () => {
    const projectPath = getProjectPath();
    if (!projectPath) return;

    const db = openProjectDb(projectPath);
    if (!db) return;

    try {
      const workspace = getOrCreateWorkspace(db, projectPath);
      const pack = generateContextPack(db, workspace.id);

      // Copy to clipboard for the user to paste
      await vscode.env.clipboard.writeText(pack);
      vscode.window.showInformationMessage(
        'MemCode: Context pack copied to clipboard. Paste it at the start of your chat.',
      );
      channel.appendLine('Context pack copied to clipboard.');
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `MemCode: Could not generate context pack — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      db.close();
    }
  });

  // ── Memory: Sync Now ────────────────────────────────────────────────
  reg('memcode.syncNow', () => {
    vscode.window.showInformationMessage(
      'MemCode: Cloud sync is a Pro feature. Visit https://memcode.pro/pricing to enable it.',
    );
  });
}
