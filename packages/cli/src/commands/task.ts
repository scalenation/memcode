import { Command } from 'commander';
import { createTask, listTasks, updateTaskStatus } from '@memcode/core';
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
  .action((options: { title: string; description?: string; priority: string }) => {
    let project;
    try {
      project = resolveProject();
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

// memory task list [--status open|in-progress|done|cancelled]
taskCommand
  .command('list')
  .description('List tasks')
  .option('--status <status>', 'Filter by status')
  .option('--limit <n>', 'Max entries', '20')
  .action((options: { status?: string; limit: string }) => {
    let project;
    try {
      project = resolveProject();
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
        options.status as TaskStatus | undefined,
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

// memory task update --id <id> --status <status>
taskCommand
  .command('update')
  .description('Update the status of a task')
  .requiredOption('--id <id>', 'Task ID')
  .requiredOption('--status <status>', 'New status: open | in-progress | done | cancelled')
  .action((options: { id: string; status: string }) => {
    let project;
    try {
      project = resolveProject();
    } catch (err: unknown) {
      console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { db } = project;
    const validStatuses: TaskStatus[] = ['open', 'in-progress', 'done', 'cancelled'];
    if (!validStatuses.includes(options.status as TaskStatus)) {
      console.error(pc.red('Invalid status.'), `Use one of: ${validStatuses.join(', ')}`);
      db.close();
      process.exit(1);
    }

    try {
      updateTaskStatus(db, options.id, options.status as TaskStatus);
      console.log(pc.green('✓'), `Task ${options.id.slice(0, 8)} status updated to ${options.status}`);
    } finally {
      db.close();
    }
  });
