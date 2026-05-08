import { Command } from 'commander';
import { createDecision, listDecisions, updateDecisionStatus } from '@memcode/core';
import { resolveProject, fmtDate, truncate } from '../util';
import pc from 'picocolors';
import type { DecisionStatus } from '@memcode/core';

export const decisionCommand = new Command('decision')
  .description('Manage architectural and process decisions');

// memory decision add --title "..." --rationale "..." [--impact "..."]
decisionCommand
  .command('add')
  .description('Record a new decision')
  .requiredOption('--title <text>', 'Decision title')
  .requiredOption('--rationale <text>', 'Rationale / reasoning')
  .option('--impact <text>', 'Impact on the codebase or team')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { title: string; rationale: string; impact?: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace } = project;

    try {
      const decision = createDecision(db, {
        workspaceId: workspace.id,
        title: options.title,
        rationale: options.rationale,
        impact: options.impact,
      });

      console.log(pc.green('✓'), pc.bold('Decision recorded'));
      console.log(`  ID       : ${pc.cyan(decision.id)}`);
      console.log(`  Title    : ${decision.title}`);
      console.log(`  Rationale: ${decision.rationale}`);
      if (decision.impact) console.log(`  Impact   : ${decision.impact}`);
      console.log(`  At       : ${fmtDate(decision.created_at)}`);
    } finally {
      db.close();
    }
  });

// memory decision list [--status active|superseded|rejected|all]
decisionCommand
  .command('list')
  .description('List decisions')
  .option('--status <status>', 'Filter by status: active | superseded | rejected | all')
  .option('--limit <n>', 'Max entries', '20')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { status?: string; limit: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace } = project;
    const limit = parseInt(options.limit, 10) || 20;

    try {
      const decisions = listDecisions(
        db,
        workspace.id,
        options.status as DecisionStatus | 'all' | undefined,
        limit,
      );

      if (decisions.length === 0) {
        console.log(pc.yellow('No decisions found.'));
        return;
      }

      console.log(pc.bold(`Decisions (${decisions.length})`));
      console.log('');
      for (const d of decisions) {
        const statusColor =
          d.status === 'active' ? pc.green : d.status === 'rejected' ? pc.red : pc.yellow;
        console.log(
          `${statusColor(`[${d.status}]`)} ${pc.bold(d.title)} ${pc.dim(d.id.slice(0, 8))}`,
        );
        console.log(`  ${pc.dim(truncate(d.rationale, 120))}`);
        console.log(`  ${pc.dim(fmtDate(d.created_at))}`);
        console.log('');
      }
    } finally {
      db.close();
    }
  });

// memory decision update --id <id> --status <status>
decisionCommand
  .command('update')
  .description('Update the status of a decision')
  .requiredOption('--id <id>', 'Decision ID (or prefix)')
  .requiredOption('--status <status>', 'New status: active | superseded | rejected')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { id: string; status: string; path?: string }) => {
    if (!options.id || options.id.trim() === '') {
      console.error(pc.red('Error:'), '--id must not be empty');
      process.exit(1);
    }

    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db } = project;
    const validStatuses: DecisionStatus[] = ['active', 'superseded', 'rejected'];
    if (!validStatuses.includes(options.status as DecisionStatus)) {
      console.error(pc.red('Invalid status.'), `Use one of: ${validStatuses.join(', ')}`);
      db.close();
      process.exit(1);
    }

    try {
      updateDecisionStatus(db, options.id, options.status as DecisionStatus);
      console.log(pc.green('✓'), `Decision ${options.id.slice(0, 8)} status updated to ${options.status}`);
    } finally {
      db.close();
    }
  });
