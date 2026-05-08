import { Command } from 'commander';
import { createCheckpoint, createCheckpointSync, generateContextPack } from '@memcode/core';
import { resolveProject, fmtDate } from '../util';
import { hasMemcodeSection, writeMemcodeSection, buildInstructionsHeader } from './copilot';
import pc from 'picocolors';

export const checkpointCommand = new Command('checkpoint')
  .description('Create a checkpoint of the current project state')
  .option('--note <text>', 'Short note describing this checkpoint')
  .option('--trigger <trigger>', 'Trigger label (manual|pre-commit|post-commit|branch-switch)', 'manual')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { note?: string; trigger: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace, projectPath } = project;

    try {
      const cp = await createCheckpoint(db, {
        workspaceId: workspace.id,
        projectPath,
        trigger: options.trigger,
        note: options.note,
      });

      console.log(pc.green('✓'), pc.bold('Checkpoint created'));
      console.log(`  ID      : ${pc.cyan(cp.id)}`);
      console.log(`  Trigger : ${cp.trigger}`);
      if (cp.branch) console.log(`  Branch  : ${cp.branch}`);
      if (cp.git_sha) console.log(`  Commit  : ${cp.git_sha.slice(0, 12)}`);
      console.log(`  Summary : ${cp.summary_short}`);
      console.log(`  At      : ${fmtDate(cp.created_at)}`);

      // Auto-refresh all configured AI assistant context files
      if (hasMemcodeSection(projectPath)) {
        try {
          const pack = generateContextPack(db, workspace.id);
          writeMemcodeSection(projectPath, buildInstructionsHeader(workspace.name) + pack);
          console.log(pc.dim('  ↳ Refreshed AI assistant context'));
        } catch { /* non-fatal */ }
      }
    } catch (err: unknown) {
      console.error(pc.red('Error creating checkpoint:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      db.close();
    }
  });
