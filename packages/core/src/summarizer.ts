import type { GitInfo } from './checkpoint';

const MAX_SHORT = 300;
const MAX_LONG = 1500;

/**
 * Generate a concise (≤300 char) one-line summary for a checkpoint.
 * No LLM required — deterministic from git metadata and trigger.
 */
export function generateShortSummary(
  gitInfo: GitInfo,
  trigger: string,
  note?: string,
): string {
  // If the user supplied a manual note, prefer it
  if (trigger === 'manual' && note) {
    return note.slice(0, MAX_SHORT);
  }

  const branch = gitInfo.branch ?? 'unknown';
  const changed = gitInfo.filesChanged?.length ?? 0;

  let base: string;
  switch (trigger) {
    case 'pre-commit':
      base = `Pre-commit: ${changed} file${changed !== 1 ? 's' : ''} staged on ${branch}`;
      break;
    case 'post-commit': {
      const msg = (gitInfo.commitMessage ?? 'commit').split('\n')[0].slice(0, 72);
      base = `Committed: "${msg}" on ${branch}`;
      break;
    }
    case 'branch-switch':
      base = `Switched to branch ${branch}`;
      break;
    case 'on-save':
      base = `Auto-save checkpoint on ${branch}`;
      break;
    default:
      base = `Checkpoint on ${branch}`;
  }

  if (note) {
    const suffix = ` — ${note}`;
    return (base + suffix).slice(0, MAX_SHORT);
  }

  return base.slice(0, MAX_SHORT);
}

/**
 * Generate a detailed (≤1500 char) multi-line summary for a checkpoint.
 */
export function generateLongSummary(
  gitInfo: GitInfo,
  trigger: string,
  note?: string,
): string {
  const lines: string[] = [];

  lines.push(`Trigger: ${trigger}`);
  if (gitInfo.branch) lines.push(`Branch: ${gitInfo.branch}`);
  if (gitInfo.sha) lines.push(`Commit: ${gitInfo.sha.slice(0, 12)}`);
  if (gitInfo.commitMessage) {
    lines.push(`Message: ${gitInfo.commitMessage.split('\n')[0].slice(0, 200)}`);
  }

  if (gitInfo.filesChanged && gitInfo.filesChanged.length > 0) {
    lines.push('');
    lines.push(`Changed files (${gitInfo.filesChanged.length}):`);
    const shown = gitInfo.filesChanged.slice(0, 20);
    shown.forEach((f) => lines.push(`  ${f}`));
    if (gitInfo.filesChanged.length > 20) {
      lines.push(`  … and ${gitInfo.filesChanged.length - 20} more`);
    }
  }

  if (gitInfo.statsSummary) {
    lines.push('');
    const stats = gitInfo.statsSummary.split('\n').slice(0, 10).join('\n');
    lines.push(`Stats:\n${stats}`);
  }

  if (note) {
    lines.push('');
    lines.push(`Note: ${note}`);
  }

  return lines.join('\n').slice(0, MAX_LONG);
}
