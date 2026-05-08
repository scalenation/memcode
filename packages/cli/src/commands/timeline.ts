import { Command } from 'commander';
import { getTimeline } from '@memcode/core';
import { resolveProject, fmtDate, truncate } from '../util';
import pc from 'picocolors';

const TYPE_COLORS: Record<string, (s: string) => string> = {
  checkpoint: pc.blue,
  decision: pc.magenta,
  task: pc.cyan,
};

const TYPE_ICONS: Record<string, string> = {
  checkpoint: '◉',
  decision: '◆',
  task: '◈',
};

export const timelineCommand = new Command('timeline')
  .description('Show a chronological timeline of memory events')
  .option('--limit <n>', 'Number of entries to show', '30')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { limit: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace } = project;
    const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 30));

    try {
      const entries = getTimeline(db, workspace.id, limit);

      if (entries.length === 0) {
        console.log(pc.yellow('No timeline entries yet.'));
        console.log(`Run ${pc.cyan('memory checkpoint')} to create your first one.`);
        return;
      }

      console.log(pc.bold(`Timeline — ${workspace.id.slice(0, 8)}…`) + pc.dim(` (${entries.length} entries)`));
      console.log('');

      for (const entry of entries) {
        const color = TYPE_COLORS[entry.type] ?? ((s: string) => s);
        const icon = TYPE_ICONS[entry.type] ?? '○';

        console.log(
          `${pc.dim(fmtDate(entry.created_at))}  ${color(icon + ' ' + entry.type.padEnd(10))}  ${pc.bold(truncate(entry.title, 70))}`,
        );
        if (entry.detail) {
          console.log(`${''.padStart(34)}${pc.dim(truncate(entry.detail, 80))}`);
        }
        if (entry.meta) {
          console.log(`${''.padStart(34)}${pc.dim('[' + entry.meta + ']')}`);
        }
      }
    } finally {
      db.close();
    }
  });
