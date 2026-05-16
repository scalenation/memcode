import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * CLI smoke tests — run the compiled CLI binary directly.
 *
 * Requires `pnpm build` to have been run in packages/cli first.
 */

const CLI = join(__dirname, '..', 'dist', 'index.js');

function run(args: string, cwd: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    }).toString();
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      code: e.status ?? 1,
    };
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `memcode-cli-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  // Init a bare git repo so git hook install can run
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('memory init', () => {
  it('creates .memory directory and database', () => {
    const result = run('init', tmpDir);
    expect(result.code).toBe(0);
    expect(existsSync(join(tmpDir, '.memory', 'memory.db'))).toBe(true);
    expect(existsSync(join(tmpDir, '.memory', 'config.json'))).toBe(true);
  });

  it('is idempotent — running twice does not error', () => {
    run('init', tmpDir);
    const result = run('init', tmpDir);
    expect(result.code).toBe(0);
  });

  it('installs git hooks with --hooks flag', () => {
    const result = run('init --hooks', tmpDir);
    expect(result.code).toBe(0);
    expect(existsSync(join(tmpDir, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(tmpDir, '.git', 'hooks', 'post-commit'))).toBe(true);
    expect(existsSync(join(tmpDir, '.git', 'hooks', 'post-checkout'))).toBe(true);
  });
});

describe('memory checkpoint', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('creates a checkpoint with a note', () => {
    const result = run('checkpoint --note "Test checkpoint"', tmpDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Checkpoint created');
    expect(result.stdout).toContain('Test checkpoint');
  });
});

describe('memory recall', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('returns no results gracefully when DB is empty', () => {
    const result = run('recall --query "anything"', tmpDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No results');
  });

  it('finds a checkpoint by keyword after creating one', () => {
    run('checkpoint --note "OAuth implementation complete"', tmpDir);
    const result = run('recall --query "oauth"', tmpDir);
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('oauth');
  });
});

describe('memory timeline', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('shows empty message when nothing is logged', () => {
    const result = run('timeline', tmpDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No timeline entries');
  });
});

describe('memory decision', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('adds and lists a decision', () => {
    run('decision add --title "Use SQLite" --rationale "Simpler for local-first"', tmpDir);
    const listResult = run('decision list', tmpDir);
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain('Use SQLite');
  });
});

describe('memory task', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('adds and lists a task', () => {
    run('task add --title "Write auth module" --priority high', tmpDir);
    const listResult = run('task list', tmpDir);
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain('Write auth module');
  });
});

describe('memory doctor', () => {
  it('fails with actionable message before init', () => {
    const result = run('doctor', tmpDir);
    expect(result.stdout + result.stderr).toMatch(/fail|not found/i);
  });

  it('passes after init', () => {
    run('init', tmpDir);
    const result = run('doctor', tmpDir);
    // May have warnings but no critical failures
    expect(result.stdout).toContain('MemCode Doctor');
  });
});

describe('memory context-pack', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('outputs a context block', () => {
    run('checkpoint --note "Initial setup"', tmpDir);
    const result = run('context-pack', tmpDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Project Memory Context');
  });
});

describe('memory service', () => {
  beforeEach(() => { run('init', tmpDir); });

  it('reports stopped status before the service is started', () => {
    const result = run('service status', tmpDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Local memory service');
    expect(result.stdout).toMatch(/stopped/i);
  });
});
