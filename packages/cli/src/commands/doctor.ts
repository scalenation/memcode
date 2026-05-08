import { Command } from 'commander';
import { existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { openDb, appliedMigrations, installedHooks, MIGRATIONS } from '@memcode/core';
import { findProjectRoot, getDbPath, getMemoryDir } from '../util';
import pc from 'picocolors';

interface CheckResult {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

function check(
  label: string,
  fn: () => { status: 'ok' | 'warn' | 'fail'; message: string },
): CheckResult {
  try {
    const result = fn();
    return { label, ...result };
  } catch (err: unknown) {
    return {
      label,
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const doctorCommand = new Command('doctor')
  .description('Validate schema, permissions, and hook wiring')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { path?: string }) => {
    const projectPath = findProjectRoot(options.path);
    const memoryDir = getMemoryDir(projectPath);
    const dbPath = getDbPath(projectPath);

    const results: CheckResult[] = [];

    // 1. .memory directory
    results.push(
      check('.memory directory exists', () => ({
        status: existsSync(memoryDir) ? 'ok' : 'fail',
        message: existsSync(memoryDir)
          ? memoryDir
          : `Not found. Run 'memory init' in ${projectPath}`,
      })),
    );

    // 2. Database file
    results.push(
      check('memory.db exists', () => ({
        status: existsSync(dbPath) ? 'ok' : 'fail',
        message: existsSync(dbPath) ? dbPath : `Not found. Run 'memory init'`,
      })),
    );

    // 3. Database permissions
    results.push(
      check('memory.db is readable and writable', () => {
        if (!existsSync(dbPath)) return { status: 'fail', message: 'File missing' };
        try {
          accessSync(dbPath, constants.R_OK | constants.W_OK);
          return { status: 'ok', message: 'Read/write OK' };
        } catch {
          return { status: 'fail', message: 'Permission denied' };
        }
      }),
    );

    // 4. Migrations current
    results.push(
      check('Migrations up to date', () => {
        if (!existsSync(dbPath)) return { status: 'fail', message: 'DB missing' };
        const db = openDb(dbPath);
        const applied = appliedMigrations(db);
        db.close();
        const expected = MIGRATIONS.map((m: { name: string }) => m.name);
        const missing = expected.filter((m: string) => !applied.includes(m));
        if (missing.length === 0) {
          return { status: 'ok', message: `All ${applied.length} migration(s) applied` };
        }
        return { status: 'fail', message: `Missing migrations: ${missing.join(', ')}` };
      }),
    );

    // 5. Git available
    results.push(
      check('git is installed', () => {
        try {
          const version = execSync('git --version', { stdio: 'pipe' }).toString().trim();
          return { status: 'ok', message: version };
        } catch {
          return { status: 'warn', message: 'git not found on PATH — hooks will not work' };
        }
      }),
    );

    // 6. Inside a git repo
    results.push(
      check('Project is a git repository', () => {
        if (existsSync(join(projectPath, '.git'))) {
          return { status: 'ok', message: join(projectPath, '.git') };
        }
        return { status: 'warn', message: 'No .git directory — hooks cannot be installed' };
      }),
    );

    // 7. Git hooks installed
    results.push(
      check('MemCode git hooks installed', () => {
        if (!existsSync(join(projectPath, '.git', 'hooks'))) {
          return { status: 'warn', message: 'No .git/hooks directory' };
        }
        const installed = installedHooks(projectPath);
        if (installed.length === 3) {
          return { status: 'ok', message: `Installed: ${installed.join(', ')}` };
        }
        if (installed.length > 0) {
          return {
            status: 'warn',
            message: `Partial (${installed.join(', ')}). Run 'memory init --hooks' to complete.`,
          };
        }
        return { status: 'warn', message: "Not installed. Run 'memory init --hooks'" };
      }),
    );

    // 8. .gitignore entries
    results.push(
      check('.gitignore excludes memory files', () => {
        const gitignorePath = join(projectPath, '.gitignore');
        if (!existsSync(gitignorePath)) {
          return { status: 'warn', message: 'No .gitignore — memory DB may be committed' };
        }
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const content = readFileSync(gitignorePath, 'utf-8');
        if (content.includes('.memory/memory.db')) {
          return { status: 'ok', message: 'memory.db and events.jsonl excluded' };
        }
        return {
          status: 'warn',
          message: 'memory.db not in .gitignore — run memory init to fix',
        };
      }),
    );

    // 9. Node version
    results.push(
      check('Node.js version', () => {
        const [major] = process.versions.node.split('.').map(Number);
        if (major >= 18) {
          return { status: 'ok', message: `v${process.versions.node}` };
        }
        return {
          status: 'warn',
          message: `v${process.versions.node} — MemCode requires Node >= 18`,
        };
      }),
    );

    // ── Print results ───────────────────────────────────────────────────
    console.log('');
    console.log(pc.bold('MemCode Doctor'));
    console.log(pc.dim(`Project: ${projectPath}`));
    console.log('');

    const icons = { ok: pc.green('✓'), warn: pc.yellow('!'), fail: pc.red('✗') };
    let failures = 0;
    let warnings = 0;

    for (const result of results) {
      const icon = icons[result.status];
      const label = result.status === 'fail'
        ? pc.red(result.label)
        : result.status === 'warn'
        ? pc.yellow(result.label)
        : result.label;
      console.log(`  ${icon}  ${label}`);
      console.log(`     ${pc.dim(result.message)}`);
      if (result.status === 'fail') failures++;
      if (result.status === 'warn') warnings++;
    }

    console.log('');
    if (failures > 0) {
      console.log(pc.red(`${failures} failure(s), ${warnings} warning(s). Run 'memory init' to fix.`));
      process.exit(1);
    } else if (warnings > 0) {
      console.log(pc.yellow(`All checks passed with ${warnings} warning(s).`));
    } else {
      console.log(pc.green('All checks passed!'));
    }
  });
