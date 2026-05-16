import type { DatabaseSync } from 'node:sqlite';
import { importChatHistory, type ChatImportResult } from './chat-import';

export function hydrateProjectContext(
  db: DatabaseSync,
  workspaceId: string,
  projectPath: string,
): ChatImportResult {
  try {
    return importChatHistory(db, workspaceId, projectPath);
  } catch {
    return { sessions: 0, messages: 0, files: 0 };
  }
}