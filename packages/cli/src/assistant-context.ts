import type { DatabaseSync } from 'node:sqlite';
import { generateContextPack, type Workspace } from '@memcode/core';
import type { ChatImportResult } from './chat-import';
import {
  configuredAgentFilePaths,
  writeMemcodeSection,
} from './assistant-adapters';
import { hydrateProjectContext } from './context-hydration';

export function buildInstructionsHeader(projectName: string): string {
  return [
    `## MemCode - Project Memory (${projectName})`,
    '',
    '> Auto-managed by [MemCode CLI](https://github.com/scalenation/memcode).',
    '> Refreshes automatically on every `memory checkpoint`. Run `memory copilot refresh` to update manually.',
    '',
    '### How to use this memory',
    '- **Active Tasks** are the source of truth for current work - reference task IDs when implementing.',
    '- **Key Decisions** record architectural choices already made. Do not suggest reversals without a clear reason.',
    '- **Recent AI Sessions** summarize recent user intent and assistant outcomes. Use them before asking the user to re-explain recent work.',
    '- After significant changes suggest running: `memory checkpoint --note "<what you did>"`',
    '- Use `memory recall --query "<topic>"` to search past context semantically.',
    '- Use `memory task add --title "<task>"` to track new work items.',
    '- Use `memory decision add --title "<decision>" --rationale "<why>"` to record architectural choices.',
    '',
  ].join('\n');
}

export function buildAssistantContextBody(
  db: DatabaseSync,
  workspace: Workspace,
  projectPath: string,
): { body: string; imported: ChatImportResult } {
  const imported = hydrateProjectContext(db, workspace.id, projectPath);
  const body = buildInstructionsHeader(workspace.name) + generateContextPack(db, workspace.id);
  return { body, imported };
}

export function refreshConfiguredAssistantContext(
  db: DatabaseSync,
  workspace: Workspace,
  projectPath: string,
): { imported: ChatImportResult; refreshedFiles: string[] } {
  const refreshedFiles = configuredAgentFilePaths(projectPath);
  const { body, imported } = buildAssistantContextBody(db, workspace, projectPath);
  if (refreshedFiles.length > 0) {
    writeMemcodeSection(projectPath, body);
  }
  return { imported, refreshedFiles };
}