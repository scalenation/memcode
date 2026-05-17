import { Command } from 'commander';
import {
  setAssumption,
  listAssumptions,
  getAssumption,
  invalidateAssumption,
  removeAssumption,
  clearAssumptions,
  formatAssumptionsForContext,
} from '@memcode/core';
import { resolveProject, fmtDate } from '../util';
import pc from 'picocolors';

const addSub = new Command('add')
  .description('Record a codebase assumption')
  .requiredOption('--key <key>', 'Short identifier for the assumption (e.g. "css-framework")')
  .requiredOption('--value <value>', 'The assumption value (e.g. "native CSS, not Tailwind")')
  .option('--source <source>', 'Source: agent|user|detected|imported', 'user')
  .option('--path <path>', 'Project path')
  .action(async (opts: { key: string; value: string; source: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const a = setAssumption(db, {
        workspaceId: workspace.id,
        key: opts.key,
        value: opts.value,
        source: opts.source as never,
      });
      console.log(pc.green('✓'), `Assumption set: ${pc.bold(a.key)} = ${a.value}`);
      console.log(`  ID    : ${pc.cyan(a.id)}`);
      console.log(`  Source: ${a.source}`);
    } finally { db.close(); }
  });

const listSub = new Command('list')
  .description('List active codebase assumptions')
  .option('--all', 'Include stale assumptions')
  .option('--path <path>', 'Project path')
  .action(async (opts: { all?: boolean; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const items = listAssumptions(db, workspace.id, opts.all);
      if (items.length === 0) {
        console.log(pc.dim('No assumptions yet. Add one with: memory assume add --key ... --value ...'));
        return;
      }
      console.log(pc.bold(`Assumptions (${items.length})`));
      for (const a of items) {
        const staleTag = a.stale ? pc.yellow(' [stale]') : '';
        console.log(`  ${pc.cyan(a.id.slice(0, 12))}  ${pc.bold(a.key)}${staleTag}`);
        console.log(`             ${a.value}`);
        console.log(`             ${pc.dim(`source: ${a.source}  updated: ${fmtDate(a.updated_at)}`)}`);
      }
    } finally { db.close(); }
  });

const invalidateSub = new Command('invalidate')
  .description('Mark an assumption as stale (do not delete — keeps audit trail)')
  .argument('<id>', 'Assumption ID or key prefix')
  .option('--path <path>', 'Project path')
  .action(async (id: string, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      // Support matching by key prefix
      const all = listAssumptions(db, workspace.id, true);
      const match = all.find((a) => a.id === id || a.id.startsWith(id) || a.key === id);
      if (!match) { console.error(pc.red(`No assumption found matching "${id}".`)); process.exit(1); }
      invalidateAssumption(db, match.id);
      console.log(pc.yellow('~'), `Assumption marked stale: ${pc.bold(match.key)}`);
    } finally { db.close(); }
  });

const rmSub = new Command('rm')
  .description('Permanently remove an assumption')
  .argument('<id>', 'Assumption ID or key')
  .option('--path <path>', 'Project path')
  .action(async (id: string, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const all = listAssumptions(db, workspace.id, true);
      const match = all.find((a) => a.id === id || a.id.startsWith(id) || a.key === id);
      if (!match) { console.error(pc.red(`No assumption found matching "${id}".`)); process.exit(1); }
      removeAssumption(db, match.id);
      console.log(pc.red('✗'), `Assumption removed: ${pc.bold(match.key)}`);
    } finally { db.close(); }
  });

const clearSub = new Command('clear')
  .description('Remove all assumptions for this workspace')
  .option('--path <path>', 'Project path')
  .option('--confirm', 'Required to avoid accidental deletion')
  .action(async (opts: { path?: string; confirm?: boolean }) => {
    if (!opts.confirm) { console.error(pc.red('Pass --confirm to clear all assumptions.')); process.exit(1); }
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      clearAssumptions(db, workspace.id);
      console.log(pc.yellow('✓'), 'All assumptions cleared.');
    } finally { db.close(); }
  });

const contextSub = new Command('context')
  .description('Print assumptions in context-pack format (for pasting into agent chat)')
  .option('--path <path>', 'Project path')
  .action(async (opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const items = listAssumptions(db, workspace.id);
      console.log(formatAssumptionsForContext(items));
    } finally { db.close(); }
  });

export const assumeCommand = new Command('assume')
  .description('Manage active codebase assumptions the agent has learned')
  .addCommand(addSub)
  .addCommand(listSub)
  .addCommand(invalidateSub)
  .addCommand(rmSub)
  .addCommand(clearSub)
  .addCommand(contextSub);
