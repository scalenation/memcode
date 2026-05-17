import { Command } from 'commander';
import {
  createEvalTask,
  listEvalTasks,
  archiveEvalTask,
  recordEvalResult,
  listEvalResults,
  evalSummary,
} from '@memcode/core';
import { resolveProject, fmtDate } from '../util';
import pc from 'picocolors';

const addSub = new Command('add')
  .description('Register a new evaluation benchmark task')
  .requiredOption('--title <title>', 'Short task title')
  .requiredOption('--description <desc>', 'Full task description')
  .option('--acceptance <json>', 'Acceptance criteria as JSON string')
  .option('--path <path>', 'Project path')
  .action(async (opts: { title: string; description: string; acceptance?: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const acceptance = opts.acceptance ? JSON.parse(opts.acceptance) : undefined;
      const task = createEvalTask(db, { workspaceId: workspace.id, title: opts.title, description: opts.description, acceptance });
      console.log(pc.green('✓'), `Eval task created: ${pc.bold(task.title)}`);
      console.log(`  ID: ${pc.cyan(task.id)}`);
    } finally { db.close(); }
  });

const listSub = new Command('list')
  .description('List eval benchmark tasks')
  .option('--path <path>', 'Project path')
  .option('--all', 'Include archived tasks')
  .action(async (opts: { path?: string; all?: boolean }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const tasks = listEvalTasks(db, workspace.id);
      if (tasks.length === 0) { console.log(pc.dim('No eval tasks yet. Add one with: memory eval add')); return; }
      console.log(pc.bold(`Eval tasks (${tasks.length})`));
      for (const t of tasks) {
        const statusTag = t.status === 'archived' ? pc.dim(' [archived]') : '';
        console.log(`  ${pc.cyan(t.id.slice(0, 12))}  ${pc.bold(t.title)}${statusTag}`);
        console.log(`             ${pc.dim((t.description ?? '').slice(0, 80))}`);    
      }
    } finally { db.close(); }
  });

const recordSub = new Command('record')
  .description('Record a result for an eval task')
  .argument('<evalTaskId>', 'Eval task ID')
  .requiredOption('--agent <name>', 'Agent or tool name (e.g. claude-3.7-sonnet)')
  .option('--model <model>', 'Model used')
  .option('--passed', 'Mark as passed')
  .option('--fail', 'Mark as failed')
  .option('--score <n>', 'Numeric score 0-1')
  .option('--notes <text>', 'Free-text notes')
  .option('--run-id <id>', 'Associated run ID')
  .option('--path <path>', 'Project path')
  .action(async (evalTaskId: string, opts: { agent: string; model?: string; passed?: boolean; fail?: boolean; score?: string; notes?: string; runId?: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db } = project;
    try {
      const passed = opts.passed ? true : opts.fail ? false : null;
      const result = recordEvalResult(db, {
        evalTaskId,
        agent: opts.agent,
        model: opts.model,
        passed: passed !== null ? passed : false,
        score: opts.score ? Number(opts.score) : undefined,
        notes: opts.notes,
        runId: opts.runId,
      });
      const icon = passed === true ? pc.green('✓') : passed === false ? pc.red('✗') : pc.dim('?');
      console.log(icon, `Result recorded for eval ${pc.cyan(evalTaskId.slice(0, 12))}`);
      console.log(`  Agent: ${result.agent}${result.model ? ` / ${result.model}` : ''}`);
      if (result.score != null) console.log(`  Score: ${result.score.toFixed(2)}`);
      if (result.notes) console.log(`  Notes: ${result.notes}`);
    } finally { db.close(); }
  });

const summarySub = new Command('summary')
  .description('Print a pass-rate summary across all eval tasks')
  .option('--path <path>', 'Project path')
  .action(async (opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const rows = evalSummary(db, workspace.id);
      if (rows.length === 0) { console.log(pc.dim('No eval results yet.')); return; }
      console.log(pc.bold('Eval summary'));
      console.log(`  ${'Task'.padEnd(30)} ${'Runs'.padEnd(6)} ${'Pass%'.padEnd(8)}`);
      console.log(`  ${'-'.repeat(50)}`);
      for (const r of rows) {
        const pct = r.runs > 0 ? (r.passRate * 100).toFixed(0) : '-';
        console.log(`  ${r.task.title.slice(0, 28).padEnd(30)} ${String(r.runs).padEnd(6)} ${(pct + '%')}`);
      }
    } finally { db.close(); }
  });

const archiveSub = new Command('archive')
  .description('Archive an eval task')
  .argument('<id>', 'Eval task ID prefix')
  .option('--path <path>', 'Project path')
  .action(async (id: string, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const tasks = listEvalTasks(db, workspace.id);
      const match = tasks.find((t) => t.id === id || t.id.startsWith(id));
      if (!match) { console.error(pc.red(`No eval task matching "${id}".`)); process.exit(1); }
      archiveEvalTask(db, match.id);
      console.log(pc.dim('✓'), `Eval task archived: ${match.title}`);
    } finally { db.close(); }
  });

export const evalCommand = new Command('eval')
  .description('Manage eval benchmark tasks and record agent performance results')
  .addCommand(addSub)
  .addCommand(listSub)
  .addCommand(recordSub)
  .addCommand(summarySub)
  .addCommand(archiveSub);
