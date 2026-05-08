import { Command } from 'commander';
import { createTask, listTasks, updateTask } from '@memcode/core';
import { resolveProject, fmtDate, truncate } from '../util';
import pc from 'picocolors';
import type { TaskStatus, TaskPriority } from '@memcode/core';

export const taskCommand = new Command('task').description('Manage project tasks');

// memory task add --title "..." [--description "..."] [--priority high|medium|low]
taskCommand
  .command('add')
  .description('Create a new task')
  .requiredOption('--title <text>', 'Task title')
  .option('--description <text>', 'Task description')
  .option('--priority <level>', 'Priority: high | medium | low', 'medium')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { title: string; description?: string; priority: string; path?: string }) => {
    let project;
    try {
      project = resolveProject(options.path);
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db, workspace } = project;
    const validPriorities: TaskPriority[] = ['low', 'medium', 'high'];
    const priority = validPriorities.includes(options.priority as TaskPriority)
      ? (options.priority as TaskPriority)
      : 'medium';

    try {
      const task = createTask(db, {
        workspaceId: workspace.id,
        title: options.title,
        description: options.description,
        priority,
      });

      console.log(pc.green('✓'), pc.bold('Task created'));
      console.log(`  ID      : ${pc.cyan(task.id)}`);
      console.log(`  Title   : ${task.title}`);
      if (task.description) console.log(`  Desc    : ${task.description}`);
      console.log(`  Priority: ${task.priority ?? 'medium'}`);
      console.log(`  Status  : ${task.status}`);
      console.log(`  At      : ${fmtDate(task.created_at)}`);
    } finally {
      db.close();
    }
  });

// memory task list [--status open|in-progress|done|cancelled|all]
taskCommand
  .command('list')
  .description('List tasks')
  .option('--status <status>', 'Filter by status: open | in-progress | done | cancelled | all')
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
      const tasks = listTasks(
        db,
        workspace.id,
        options.status as TaskStatus | 'all' | undefined,
        limit,
      );

      if (tasks.length === 0) {
        console.log(pc.yellow('No tasks found.'));
        return;
      }

      console.log(pc.bold(`Tasks (${tasks.length})`));
      console.log('');
      for (const t of tasks) {
        const statusColor: Record<string, (s: string) => string> = {
          open: pc.white,
          'in-progress': pc.yellow,
          done: pc.green,
          cancelled: pc.dim,
        };
        const color = statusColor[t.status] ?? pc.white;
        const prio = t.priority
          ? pc.dim(` [${t.priority}]`)
          : '';
        console.log(`${color(`[${t.status}]`)}${prio} ${pc.bold(t.title)} ${pc.dim(t.id.slice(0, 8))}`);
        if (t.description) console.log(`  ${pc.dim(truncate(t.description, 120))}`);
        console.log(`  ${pc.dim(fmtDate(t.created_at))}`);
        console.log('');
      }
    } finally {
      db.close();
    }
  });

// memory task update --id <id> [--status <status>] [--priority <priority>]
taskCommand
  .command('update')
  .description('Update the status of a task')
  .requiredOption('--id <id>', 'Task ID (or prefix)')
  .option('--status <status>', 'New status: open | in-progress | done | cancelled')
  .option('--priority <level>', 'New priority: low | medium | high')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { id: string; status?: string; priority?: string; path?: string }) => {
    if (!options.id || options.id.trim() === '') {
      console.error(pc.red('Error:'), '--id must not be empty');
      process.exit(1);
    }
    if (!options.status && !options.priority) {
      console.error(pc.red('Error:'), 'Provide at least --status or --priority');
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
    const validStatuses: TaskStatus[] = ['open', 'in-progress', 'done', 'cancelled'];
    const validPriorities: TaskPriority[] = ['low', 'medium', 'high'];

    if (options.status && !validStatuses.includes(options.status as TaskStatus)) {
      console.error(pc.red('Invalid status.'), `Use one of: ${validStatuses.join(', ')}`);
      db.close();
      process.exit(1);
    }
    if (options.priority && !validPriorities.includes(options.priority as TaskPriority)) {
      console.error(pc.red('Invalid priority.'), `Use one of: ${validPriorities.join(', ')}`);
      db.close();
      process.exit(1);
    }

    try {
      updateTask(db, options.id, {
        status: options.status as TaskStatus | undefined,
        priority: options.priority as TaskPriority | undefined,
      });
      const changes: string[] = [];
      if (options.status) changes.push(`status → ${options.status}`);
      if (options.priority) changes.push(`priority → ${options.priority}`);
      console.log(pc.green('✓'), `Task ${options.id.slice(0, 8)} updated: ${changes.join(', ')}`);
    } finally {
      db.close();
    }
  });
