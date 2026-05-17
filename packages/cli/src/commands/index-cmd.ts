import { Command } from 'commander';
import {
  buildRepoIndex,
  listIndexEntries,
  clearIndex,
  formatIndexForContext,
} from '@memcode/core';
import type { RepoIndexKind } from '@memcode/core';
import { resolveProject } from '../util';
import pc from 'picocolors';

const scanSub = new Command('scan')
  .description('Scan the project and build the repo index')
  .option('--path <path>', 'Project path')
  .option('--kinds <kinds>', 'Comma-separated: component,endpoint,test,convention,module,schema', '')
  .option('--depth <n>', 'Max directory depth to scan', '8')
  .action(async (opts: { path?: string; kinds: string; depth: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace, projectPath } = project;
    try {
      console.log(pc.dim('Scanning project tree…'));
      const kinds = opts.kinds
        ? (opts.kinds.split(',').map((k) => k.trim()) as RepoIndexKind[])
        : undefined;
      const stats = buildRepoIndex(db, {
        workspaceId: workspace.id,
        projectPath,
        kinds,
        maxDepth: Number(opts.depth),
      });
      console.log(pc.green('✓'), 'Repo index built');
      console.log(`  Components  : ${stats.components}`);
      console.log(`  Endpoints   : ${stats.endpoints}`);
      console.log(`  Tests       : ${stats.tests}`);
      console.log(`  Conventions : ${stats.conventions}`);
      console.log(`  Modules     : ${stats.modules}`);
      console.log(`  Duration    : ${stats.duration_ms}ms`);
    } finally { db.close(); }
  });

const showSub = new Command('show')
  .description('List all indexed entries')
  .option('--path <path>', 'Project path')
  .option('--kind <kind>', 'Filter by kind: component|endpoint|test|convention|module|schema')
  .action(async (opts: { path?: string; kind?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const entries = listIndexEntries(db, workspace.id, opts.kind as RepoIndexKind | undefined);
      if (entries.length === 0) {
        console.log(pc.dim('No index entries yet. Run: memory index scan'));
        return;
      }

      const byKind: Partial<Record<string, typeof entries>> = {};
      for (const e of entries) { (byKind[e.kind] ??= []).push(e); }

      for (const [kind, list] of Object.entries(byKind)) {
        console.log(pc.bold(`${kind} (${list!.length})`));
        for (const e of list!) {
          console.log(`  ${pc.dim(e.path.padEnd(50))} ${e.label}`);
        }
        console.log('');
      }
    } finally { db.close(); }
  });

const contextSub = new Command('context')
  .description('Print the index as a context block for agent injection')
  .option('--path <path>', 'Project path')
  .option('--kind <kind>', 'Filter by kind')
  .action(async (opts: { path?: string; kind?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const entries = listIndexEntries(db, workspace.id, opts.kind as RepoIndexKind | undefined);
      console.log(formatIndexForContext(entries, workspace.id));
    } finally { db.close(); }
  });

const clearSub = new Command('clear')
  .description('Clear the repo index (will be rebuilt on next scan)')
  .option('--path <path>', 'Project path')
  .option('--kind <kind>', 'Only clear entries of this kind')
  .action(async (opts: { path?: string; kind?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      clearIndex(db, workspace.id, opts.kind as RepoIndexKind | undefined);
      console.log(pc.yellow('✓'), `Index cleared${opts.kind ? ` (kind: ${opts.kind})` : ''}.`);
    } finally { db.close(); }
  });

export const indexCommand = new Command('index')
  .description('Manage the auto-maintained repo index (components, endpoints, tests, conventions)')
  .addCommand(scanSub)
  .addCommand(showSub)
  .addCommand(contextSub)
  .addCommand(clearSub);
