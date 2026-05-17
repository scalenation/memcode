import { Command } from 'commander';
import {
  createRun,
  getActiveRun,
  getRun,
  listRuns,
  startRun,
  setPlan,
  approveRun,
  pauseRun,
  resumeRun,
  cancelRun,
  rollbackRun,
  finishRun,
  addRunStep,
  finishRunStep,
  listRunSteps,
  listRunEvents,
  listRunArtifacts,
  addRunArtifact,
  buildPlanOptions,
  stashBeforeRun,
  createRunWorktree,
  listAssumptions,
  listIndexEntries,
  generateContextPack,
  defaultRouter,
} from '@memcode/core';
import { resolveProject, fmtDate } from '../util';
import pc from 'picocolors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(s: string): string {
  switch (s) {
    case 'done': return pc.green(s);
    case 'failed': return pc.red(s);
    case 'cancelled': case 'rolled-back': return pc.yellow(s);
    case 'executing': case 'running': return pc.cyan(s);
    case 'awaiting-approval': return pc.magenta(s);
    case 'paused': return pc.yellow(s);
    default: return pc.dim(s);
  }
}

function printRun(run: ReturnType<typeof getRun>): void {
  if (!run) return;
  console.log(`  ID        : ${pc.cyan(run.id)}`);
  console.log(`  Title     : ${pc.bold(run.title)}`);
  console.log(`  Status    : ${statusColor(run.status)}`);
  if (run.git_branch) console.log(`  Branch    : ${run.git_branch}`);
  if (run.git_sha_before) console.log(`  SHA-before: ${run.git_sha_before.slice(0, 12)}`);
  console.log(`  Created   : ${fmtDate(run.created_at)}`);
  if (run.finished_at) console.log(`  Finished  : ${fmtDate(run.finished_at)}`);
}

// ── Sub-commands ──────────────────────────────────────────────────────────────

const startSub = new Command('start')
  .description('Start a new orchestrated agent run for a task')
  .argument('<title>', 'Task description')
  .option('--path <path>', 'Project path')
  .option('--worktree', 'Create an isolated git worktree for this run')
  .option('--stash', 'Stash current changes before the run for easy rollback')
  .option('--no-plan', 'Skip the planning phase and execute immediately')
  .option('--options <n>', 'Number of plan options to generate', '3')
  .action(async (title: string, opts: { path?: string; worktree?: boolean; stash?: boolean; plan: boolean; options: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }

    const { db, workspace, projectPath } = project;
    try {
      // Protect working tree
      let stashRef: string | undefined;
      let worktreePath: string | undefined;

      if (opts.stash) {
        stashRef = stashBeforeRun(projectPath);
        if (stashRef) console.log(pc.dim(`  ↳ Stashed working tree: ${stashRef}`));
      }

      // Routing decision
      const routing = defaultRouter.route(title);
      console.log(pc.dim(`  ↳ Suggested model tier: ${routing.tier} (${routing.model})`));
      console.log(pc.dim(`    Reason: ${routing.reason}`));

      const run = createRun(db, { workspaceId: workspace.id, projectPath, title });

      if (opts.worktree) {
        worktreePath = createRunWorktree(projectPath, run.id);
        if (worktreePath) {
          console.log(pc.dim(`  ↳ Git worktree: ${worktreePath}`));
        }
      }

      startRun(db, run.id);
      console.log(pc.green('✓'), pc.bold('Run started'));
      printRun(getRun(db, run.id));

      if (opts.plan !== false) {
        // Build plan options using available context
        let contextSummary = '';
        try {
          contextSummary = generateContextPack(db, workspace.id).slice(0, 600);
        } catch { /* non-fatal */ }

        const count = Math.max(1, Math.min(5, Number(opts.options) || 3));
        const plans = buildPlanOptions(title, contextSummary, count);
        setPlan(db, run.id, plans);

        console.log('');
        console.log(pc.bold('Plan options:'));
        for (const p of plans) {
          console.log('');
          console.log(`  ${pc.bold(`Option ${p.index}:`)} ${pc.cyan(p.title)}`);
          console.log(`  ${pc.dim('Risk:')} ${p.riskLevel} · ${pc.dim('Est. files:')} ~${p.estimatedFiles}`);
          console.log(`  ${p.approach.split('\n')[0]}`);
          console.log(`  ${pc.green('+')} ${p.pros.join('  + ')}`);
          console.log(`  ${pc.red('-')} ${p.cons.join('  - ')}`);
        }
        console.log('');
        console.log(pc.dim(`Run ${pc.bold(`memory run approve --option <N> ${run.id}`)} to proceed.`));
      } else {
        // Skip plan, go straight to executing
        approveRun(db, run.id, 0);
        console.log(pc.dim('  ↳ Planning skipped. Run is executing.'));
      }
    } finally { db.close(); }
  });

const approveSub = new Command('approve')
  .description('Approve a plan option and advance the run to execution')
  .argument('[runId]', 'Run ID (defaults to active run)')
  .option('--option <n>', 'Plan option number to select', '1')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { option: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.error(pc.red('No active run found. Start one with: memory run start "<task>"')); process.exit(1); }
      const option = Number(opts.option);
      approveRun(db, run.id, option);
      console.log(pc.green('✓'), `Approved option ${option} for run ${pc.cyan(run.id)}`);
      console.log(pc.dim('Run is now executing. Record steps with: memory run log ...'));
    } finally { db.close(); }
  });

const pauseSub = new Command('pause')
  .description('Pause the active run')
  .argument('[runId]', 'Run ID (defaults to active run)')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.error(pc.red('No active run.')); process.exit(1); }
      pauseRun(db, run.id);
      console.log(pc.yellow('⏸'), `Run ${pc.cyan(run.id)} paused.`);
    } finally { db.close(); }
  });

const resumeSub = new Command('resume')
  .description('Resume a paused run')
  .argument('[runId]', 'Run ID (defaults to most recent paused run)')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.error(pc.red('No paused run found.')); process.exit(1); }
      resumeRun(db, run.id);
      console.log(pc.green('▶'), `Run ${pc.cyan(run.id)} resumed.`);
    } finally { db.close(); }
  });

const rollbackSub = new Command('rollback')
  .description('Roll back a run to its pre-task git state')
  .argument('[runId]', 'Run ID (defaults to active run)')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace, projectPath } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.error(pc.red('No run found.')); process.exit(1); }
      const result = rollbackRun(db, run.id, projectPath);
      console.log(pc.yellow('↩'), `Run ${pc.cyan(run.id)} rolled back.`);
      console.log(`  ${result.message}`);
    } finally { db.close(); }
  });

const finishSub = new Command('finish')
  .description('Mark the active run as done or failed')
  .argument('[runId]', 'Run ID (defaults to active run)')
  .option('--fail', 'Mark as failed instead of done')
  .option('--note <text>', 'Optional outcome note')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { fail?: boolean; note?: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.error(pc.red('No active run.')); process.exit(1); }
      finishRun(db, run.id, !opts.fail, opts.note);
      const icon = opts.fail ? pc.red('✗') : pc.green('✓');
      console.log(icon, `Run ${pc.cyan(run.id)} marked as ${opts.fail ? 'failed' : 'done'}.`);
    } finally { db.close(); }
  });

const statusSub = new Command('status')
  .description('Show the status of the active or specified run')
  .argument('[runId]', 'Run ID (defaults to active run)')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.log(pc.dim('No active run. Start one with: memory run start "<task>"')); return; }

      console.log(pc.bold('Run'));
      printRun(run);

      const steps = listRunSteps(db, run.id);
      if (steps.length > 0) {
        console.log('');
        console.log(pc.bold('Steps'));
        for (const s of steps) {
          const dur = s.finished_at && s.started_at ? `${((s.finished_at - s.started_at) / 1000).toFixed(1)}s` : '';
          console.log(`  ${statusColor(s.status)} ${pc.dim(`[${s.phase}]`)} ${s.label} ${pc.dim(dur)}`);
        }
      }

      if (run.plan_json) {
        const plans = JSON.parse(run.plan_json) as Array<{ index: number; title: string }>;
        console.log('');
        console.log(pc.bold('Plan options'));
        for (const p of plans) {
          const selected = run.selected_option === p.index;
          console.log(`  ${selected ? pc.green('✓') : ' '} Option ${p.index}: ${p.title}`);
        }
      }
    } finally { db.close(); }
  });

const listSub = new Command('list')
  .description('List recent runs')
  .option('--path <path>', 'Project path')
  .option('--limit <n>', 'Max runs to show', '15')
  .action(async (opts: { path?: string; limit: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const runs = listRuns(db, workspace.id, Number(opts.limit));
      if (runs.length === 0) { console.log(pc.dim('No runs yet. Start one with: memory run start "<task>"')); return; }
      console.log(pc.bold(`Recent runs (${runs.length})`));
      for (const r of runs) {
        const dur = r.finished_at ? ` ${Math.round((r.finished_at - r.created_at) / 1000)}s` : '';
        console.log(`  ${statusColor(r.status).padEnd(10)} ${pc.cyan(r.id.slice(0, 12))}  ${r.title.slice(0, 60)}${dur}`);
      }
    } finally { db.close(); }
  });

const inspectSub = new Command('inspect')
  .description('Print full details of a run: steps, events, and artifacts')
  .argument('<runId>', 'Run ID')
  .option('--path <path>', 'Project path')
  .option('--events', 'Include raw event log')
  .action(async (runId: string, opts: { path?: string; events?: boolean }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db } = project;
    try {
      const run = getRun(db, runId);
      if (!run) { console.error(pc.red(`Run ${runId} not found.`)); process.exit(1); }

      console.log(pc.bold('── Run ──────────────────────────────────────────────'));
      printRun(run);

      const steps = listRunSteps(db, run.id);
      if (steps.length > 0) {
        console.log('');
        console.log(pc.bold('── Steps ────────────────────────────────────────────'));
        for (const s of steps) {
          console.log(`  ${statusColor(s.status)} ${s.seq}. [${s.phase}] ${s.label}`);
          if (s.model) console.log(`     model: ${s.model}${s.cost_usd != null ? `  cost: $${s.cost_usd.toFixed(4)}` : ''}`);
          if (s.output_json) {
            try {
              const out = JSON.parse(s.output_json);
              console.log(`     output: ${JSON.stringify(out).slice(0, 200)}`);
            } catch { /* skip */ }
          }
        }
      }

      const artifacts = listRunArtifacts(db, run.id);
      if (artifacts.length > 0) {
        console.log('');
        console.log(pc.bold('── Artifacts ────────────────────────────────────────'));
        for (const a of artifacts) {
          console.log(`  ${pc.dim(a.kind.padEnd(12))} ${a.label ?? a.id.slice(0, 12)}`);
          if (a.content) console.log(`  ${pc.dim(a.content.slice(0, 200))}`);
        }
      }

      if (opts.events) {
        const events = listRunEvents(db, run.id);
        console.log('');
        console.log(pc.bold('── Events ───────────────────────────────────────────'));
        for (const e of events) {
          const payload = e.payload_json ? JSON.parse(e.payload_json) : {};
          console.log(`  ${fmtDate(e.created_at)}  ${pc.cyan(e.type)}  ${JSON.stringify(payload).slice(0, 120)}`);
        }
      }
    } finally { db.close(); }
  });

const logSub = new Command('log')
  .description('Record a step or event from within an agent run')
  .argument('[runId]', 'Run ID (defaults to active run)')
  .requiredOption('--phase <phase>', 'Step phase: retrieve|plan|build|validate|review|commit|deploy|custom')
  .requiredOption('--label <text>', 'Step description')
  .option('--done', 'Mark the step done immediately')
  .option('--fail', 'Mark the step failed immediately')
  .option('--output <json>', 'JSON output string to record')
  .option('--model <model>', 'Model used for this step')
  .option('--cost <usd>', 'Cost in USD')
  .option('--artifact-kind <kind>', 'Also save an artifact of this kind')
  .option('--artifact-content <text>', 'Artifact content (use --artifact-file for large content)')
  .option('--path <path>', 'Project path')
  .action(async (runId: string | undefined, opts: { phase: string; label: string; done?: boolean; fail?: boolean; output?: string; model?: string; cost?: string; artifactKind?: string; artifactContent?: string; path?: string }) => {
    let project;
    try { project = resolveProject(opts.path); }
    catch (err: unknown) { console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err)); process.exit(1); }
    const { db, workspace } = project;
    try {
      const run = runId ? getRun(db, runId) : getActiveRun(db, workspace.id);
      if (!run) { console.error(pc.red('No active run.')); process.exit(1); }

      const step = addRunStep(db, {
        runId: run.id,
        phase: opts.phase as never,
        label: opts.label,
      });

      if (opts.done || opts.fail) {
        const output = opts.output ? JSON.parse(opts.output) : undefined;
        finishRunStep(db, step.id, !opts.fail, output, opts.cost ? Number(opts.cost) : undefined, opts.model);
      }

      if (opts.artifactKind && opts.artifactContent) {
        addRunArtifact(db, run.id, opts.artifactKind, opts.artifactContent, { stepId: step.id, label: opts.label });
      }

      console.log(pc.green('✓'), `Step logged: [${opts.phase}] ${opts.label}`);
    } finally { db.close(); }
  });

const routeSub = new Command('route')
  .description('Show which model tier MemCode would route this task to')
  .argument('<task>', 'Task description to route')
  .action((task: string) => {
    const result = defaultRouter.route(task);
    console.log(pc.bold('Model routing'));
    console.log(`  Task   : ${task}`);
    console.log(`  Tier   : ${pc.cyan(result.tier)}`);
    console.log(`  Model  : ${pc.bold(result.model)}`);
    console.log(`  Reason : ${result.reason}`);
    console.log(`  Pattern: ${pc.dim(result.matchedPattern)}`);
  });

// ── Root ──────────────────────────────────────────────────────────────────────

export const runCommand = new Command('run')
  .description('Orchestrate agent runs: plan, approve, execute, validate, rollback')
  .addCommand(startSub)
  .addCommand(approveSub)
  .addCommand(pauseSub)
  .addCommand(resumeSub)
  .addCommand(rollbackSub)
  .addCommand(finishSub)
  .addCommand(statusSub)
  .addCommand(listSub)
  .addCommand(inspectSub)
  .addCommand(logSub)
  .addCommand(routeSub);
