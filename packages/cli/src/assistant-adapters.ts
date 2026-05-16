import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER_START = '<!-- memcode:start -->';
const MARKER_END = '<!-- memcode:end -->';

export type Agent = 'copilot' | 'claude' | 'all';

export function copilotFilePath(projectPath: string): string {
  return join(projectPath, '.github', 'copilot-instructions.md');
}

export function claudeFilePath(projectPath: string): string {
  return join(projectPath, 'CLAUDE.md');
}

export function agentFilePaths(projectPath: string, agent: Agent): string[] {
  if (agent === 'copilot') return [copilotFilePath(projectPath)];
  if (agent === 'claude') return [claudeFilePath(projectPath)];
  return [copilotFilePath(projectPath), claudeFilePath(projectPath)];
}

export function agentLabel(filePath: string, projectPath: string): string {
  const labels: Record<string, string> = {
    [copilotFilePath(projectPath)]: 'VS Code Copilot  -> .github/copilot-instructions.md',
    [claudeFilePath(projectPath)]: 'Claude Code      -> CLAUDE.md',
  };
  return labels[filePath] ?? filePath;
}

export function upsertManagedSection(filePath: string, body: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const section = `${MARKER_START}\n${body}\n${MARKER_END}`;

  if (existsSync(filePath)) {
    let existing = readFileSync(filePath, 'utf-8');
    const start = existing.indexOf(MARKER_START);
    const end = existing.indexOf(MARKER_END);
    if (start !== -1 && end !== -1 && end > start) {
      existing =
        existing.slice(0, start).trimEnd() +
        (start > 0 ? '\n\n' : '') +
        section +
        existing.slice(end + MARKER_END.length).trimStart();
      if (!existing.endsWith('\n')) existing += '\n';
    } else {
      existing = existing.trimEnd() + '\n\n' + section + '\n';
    }
    writeFileSync(filePath, existing, 'utf-8');
    return;
  }

  writeFileSync(filePath, section + '\n', 'utf-8');
}

export function hasManagedSection(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

export function configuredAgentFilePaths(projectPath: string): string[] {
  return agentFilePaths(projectPath, 'all').filter(hasManagedSection);
}

export function hasMemcodeSection(projectPath: string): boolean {
  return configuredAgentFilePaths(projectPath).length > 0;
}

export function writeMemcodeSection(projectPath: string, body: string): void {
  for (const filePath of configuredAgentFilePaths(projectPath)) {
    upsertManagedSection(filePath, body);
  }
}