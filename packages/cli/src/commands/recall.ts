import { Command } from 'commander';
import { recall, recallSync } from '@memcode/core';
import { resolveProject, fmtDate, truncate } from '../util';
import pc from 'picocolors';

export const recallCommand = new Command('recall')
  .description('Recall ranked memory entries matching a query')
  .requiredOption('--query <text>', 'Search query')
  .option('--limit <n>', 'Maximum results to return', '10')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { query: string; limit: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace } = project;
    const limit = Math.max(1, Math.min(50, parseInt(options.limit, 10) || 10));

    try {
      const results = await recall(db, workspace.id, options.query, limit);

      if (results.length === 0) {
        console.log(pc.yellow('No results found for:'), pc.bold(options.query));
        console.log('Try a different query or add more checkpoints and decisions.');
        return;
      }

      console.log(
        pc.bold(`Recall results for "${options.query}"`) +
          pc.dim(` (${results.length} of ${limit} max)`),
      );
      console.log('');

      for (const [i, result] of results.entries()) {
        const typeLabel = {
          decision: pc.magenta('decision'),
          checkpoint: pc.blue('checkpoint'),
          task: pc.cyan('task'),
        }[result.type] ?? result.type;

        console.log(
          `${pc.dim(`${i + 1}.`)} [${typeLabel}] ${pc.bold(truncate(result.title, 80))}`,
        );
        console.log(`   ${pc.dim(truncate(result.detail, 120))}`);
        console.log(`   ${pc.dim('↳')} ${pc.dim(result.reason)} ${pc.dim(`| ${fmtDate(result.created_at)}`)}`);
        console.log('');
      }
    } finally {
      db.close();
    }
  });
