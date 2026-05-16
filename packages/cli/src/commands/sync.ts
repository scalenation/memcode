import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { pushSync, pullSync, deriveKey } from '@memcode/cloud-client';
import { findProjectRoot, getMemoryDir, resolveProject } from '../util';
import { importChatHistory } from '../chat-import';
import { hydrateProjectContext } from '../context-hydration';

const DEFAULT_ENDPOINT = 'https://www.memcode.pro';
const AUTH_CONFIG_PATH = join(homedir(), '.config', 'memcode', 'auth.json');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CLI_VERSION: string = (require('../../package.json') as { version: string }).version;
const CLI_UA = `MemCode CLI/${CLI_VERSION}`;

interface DaemonState {
  pid: number;
  projectPath: string;
  intervalSeconds: number;
  startedAt: string;
}

/**
 * Detect the current IDE or terminal environment.
 * Returns a human-readable string like "VS Code", "Cursor", "JetBrains", or the hostname.
 */
function detectEnvironment(): string {
  const env = process.env;
  // VS Code (all flavours: stable, insiders, Cursor, Windsurf, etc.)
  if (env.TERM_PROGRAM === 'vscode' || env.VSCODE_PID || env.VSCODE_IPC_HOOK) {
    if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID || (env.TERM_PROGRAM_VERSION ?? '').toLowerCase().includes('cursor')) return 'Cursor';
    return 'VS Code';
  }
  // JetBrains IDEs expose a env var prefixed with JETBRAINS_
  if (Object.keys(env).some(k => k.startsWith('JETBRAINS_'))) return 'JetBrains';
  // Neovim / Vim
  if (env.NVIM || env.NVIM_LISTEN_ADDRESS) return 'Neovim';
  if (env.VIM) return 'Vim';
  // Terminal apps
  if (env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2';
  if (env.TERM_PROGRAM === 'Terminal.app') return 'Terminal';
  if (env.TERM_PROGRAM === 'Hyper') return 'Hyper';
  if (env.TERM_PROGRAM === 'WezTerm') return 'WezTerm';
  if (env.TERM_PROGRAM === 'ghostty') return 'Ghostty';
  // Fall back to hostname
  return hostname();
}

/**
 * Prompt the user for a single line of input.
 * When `muted` is true the typed characters are not echoed (for passwords).
 */
function askQuestion(question: string, muted = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (muted) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        // Only allow the question text itself (contains the question string) — suppress typed chars
        if (s === question || s.startsWith('\r') || s === '\n') process.stderr.write(s);
      };
    }
    rl.question(question, (answer) => {
      if (muted) process.stderr.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

interface AuthConfig {
  endpoint: string;
  apiToken: string;
  encryptionPassphrase: string;
}

interface SyncContext {
  auth: AuthConfig;
  projectPath: string;
  db: ReturnType<typeof resolveProject>['db'];
  workspace: ReturnType<typeof resolveProject>['workspace'];
  encryptionKey: string;
}

interface PullSyncResultSummary {
  merged: {
    sessions: number;
    messages: number;
    checkpoints: number;
    decisions: number;
    tasks: number;
  };
  cursor: string;
  skippedBlobs?: number;
}

interface PushSyncResultSummary {
  checkpointsCount: number;
  decisionsCount: number;
  tasksCount: number;
  brainMilestonesCount: number;
  cursor: string;
}

function readAuthConfig(): AuthConfig | null {
  if (!existsSync(AUTH_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf-8')) as AuthConfig;
  } catch {
    return null;
  }
}

function writeAuthConfig(cfg: AuthConfig): void {
  mkdirSync(join(homedir(), '.config', 'memcode'), { recursive: true });
  writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function createSyncContext(path?: string): SyncContext | null {
  const auth = readAuthConfig();
  if (!auth) return null;
  const projectPath = path ?? findProjectRoot();
  const { db, workspace } = resolveProject(projectPath);
  return {
    auth,
    projectPath,
    db,
    workspace,
    encryptionKey: deriveKey(auth.encryptionPassphrase, workspace.id),
  };
}

async function runPullPhase(
  ctx: SyncContext,
  options: { quiet?: boolean } = {},
): Promise<PullSyncResultSummary> {
  const { quiet = false } = options;
  const result = await pullSync(ctx.db, {
    endpoint: ctx.auth.endpoint,
    apiToken: ctx.auth.apiToken,
    encryptionKey: ctx.encryptionKey,
    workspaceId: ctx.workspace.id,
  });

  if (!quiet) {
    if (result.merged.sessions === 0 && result.merged.messages === 0 && result.merged.checkpoints === 0 && result.merged.decisions === 0 && result.merged.tasks === 0) {
      console.log(pc.green('✓'), 'Cloud pull already up to date.');
    } else {
      console.log(pc.green('✓'), `Pulled ${pc.cyan(String(result.merged.sessions))} sessions,`, `${pc.cyan(String(result.merged.messages))} messages,`, `${pc.cyan(String(result.merged.checkpoints))} checkpoints,`, `${pc.cyan(String(result.merged.decisions))} decisions,`, `${pc.cyan(String(result.merged.tasks))} tasks`);
    }
    if (result.skippedBlobs) {
      console.log(pc.yellow('!'), `Skipped ${result.skippedBlobs} cloud snapshot${result.skippedBlobs === 1 ? '' : 's'} that could not be decrypted with this workspace key.`);
    }
    console.log(pc.dim(`  pull cursor: ${result.cursor}`));
  }

  return result;
}

async function runPushPhase(
  ctx: SyncContext,
  options: { quiet?: boolean } = {},
): Promise<{ result: PushSyncResultSummary; imported: { sessions: number; messages: number } }> {
  const { quiet = false } = options;
  const imported = hydrateProjectContext(ctx.db, ctx.workspace.id, ctx.projectPath);
  await registerWorkspace(ctx.auth, ctx.workspace.id, ctx.projectPath);
  const result = await pushSync(ctx.db, {
    endpoint: ctx.auth.endpoint,
    apiToken: ctx.auth.apiToken,
    encryptionKey: ctx.encryptionKey,
    workspaceId: ctx.workspace.id,
  });

  if (!quiet) {
    console.log(pc.green('✓'), `Pushed ${pc.cyan(String(result.checkpointsCount))} checkpoints,`, `${pc.cyan(String(result.decisionsCount))} decisions,`, `${pc.cyan(String(result.tasksCount))} tasks,`, `${pc.cyan(String(result.brainMilestonesCount))} brain milestones`);
    if (imported.sessions > 0 || imported.messages > 0) {
      console.log(pc.dim(`  imported chat: ${imported.sessions} sessions, ${imported.messages} messages`));
    }
    console.log(pc.dim(`  push cursor: ${result.cursor}`));
  }

  return { result, imported };
}

export const syncCommand = new Command('sync').description(
  'Sync project memory with the cloud (Pro feature — memcode.pro/pricing)',
)
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { path?: string }) => {
    await runAutoSync(options.path);
  });

async function registerWorkspace(
  auth: AuthConfig,
  workspaceId: string,
  projectPath: string,
): Promise<void> {
  await fetch(`${auth.endpoint.replace(/\/$/, '')}/v1/sync/workspace`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.apiToken}`,
      'User-Agent': CLI_UA,
    },
    body: JSON.stringify({
      workspaceId,
      name: basename(projectPath),
      machineName: detectEnvironment(),
    }),
  }).catch(() => undefined);
}

async function runAutoSync(
  path?: string,
  options: { quiet?: boolean; exitOnError?: boolean } = {},
): Promise<boolean> {
  const { quiet = false, exitOnError = true } = options;
  const ctx = createSyncContext(path);
  if (!ctx) {
    if (!quiet) console.log(noAuthMsg());
    if (exitOnError) process.exit(1);
    return false;
  }

  if (!quiet) console.log(pc.bold('Syncing memory with cloud (pull -> push)…'));
  try {
    await runPullPhase(ctx, { quiet });
    await runPushPhase(ctx, { quiet });
    return true;
  } catch (err) {
    if (!quiet) console.error(pc.red('Sync failed:'), (err as Error).message);
    if (exitOnError) process.exit(1);
    return false;
  } finally {
    ctx.db.close();
  }
}

function daemonStatePath(projectPath: string): string {
  return join(getMemoryDir(projectPath), 'sync-daemon.json');
}

function readDaemonState(projectPath: string): DaemonState | null {
  const statePath = daemonStatePath(projectPath);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as DaemonState;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearDaemonState(projectPath: string): void {
  const statePath = daemonStatePath(projectPath);
  if (existsSync(statePath)) {
    try { unlinkSync(statePath); } catch { /* best effort */ }
  }
}

// ─── auth ───────────────────────────────────────────────────────────────────

syncCommand
  .command('auth')
  .description('Authenticate with the MemCode cloud and save credentials locally')
  .option('--endpoint <url>', 'API endpoint', DEFAULT_ENDPOINT)
  .action(async (options: { endpoint: string }) => {
    console.error(pc.bold('\nMemCode Cloud — authenticate\n'));

    try {
      const email    = await askQuestion('Email: ');
      const password = await askQuestion('Password: ', true);

      if (!email || !password) {
        console.error(pc.red('Email and password are required.'));
        process.exit(1);
      }

      const endpoint = options.endpoint.replace(/\/$/, '');
      let token: string | null = null;
      let isNewAccount = false;

      const loginRes = await fetch(`${endpoint}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA },
        body: JSON.stringify({ email, password }),
      });

      if (loginRes.ok) {
        const body = (await loginRes.json()) as { token: string };
        token = body.token;
        console.log(pc.green('✓'), 'Logged in as', pc.cyan(email));
      } else if (loginRes.status === 404) {
        // No account — offer to create one
        const createAnswer = await askQuestion(`\nNo account found for ${pc.cyan(email)}. Create one? (y/N): `);
        if (createAnswer.trim().toLowerCase() !== 'y') {
          console.error(pc.yellow('Cancelled.'));
          process.exit(0);
        }
        const registerRes = await fetch(`${endpoint}/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_UA },
          body: JSON.stringify({ email, password }),
        });
        if (registerRes.ok) {
          const body = (await registerRes.json()) as { token: string };
          token = body.token;
          isNewAccount = true;
          console.log(pc.green('✓'), 'Account created for', pc.cyan(email));
        } else {
          const err = (await registerRes.json().catch(() => ({}))) as { error?: string };
          console.error(pc.red('✗'), err.error ?? 'Registration failed');
          process.exit(1);
        }
      } else {
        // 401 wrong password, 403 OAuth account, or other server error
        const err = (await loginRes.json().catch(() => ({}))) as { error?: string };
        console.error(pc.red('✗'), err.error ?? 'Authentication failed');
        if (loginRes.status === 403) {
          console.error(pc.dim('  Tip: go to memcode.pro dashboard → Profile to set a CLI password.'));
        }
        process.exit(1);
      }

      if (!token) {
        console.error(pc.red('Failed to obtain auth token.'));
        process.exit(1);
      }

      // Prompt for encryption passphrase — explain what it is
      console.error('');
      console.error(pc.bold('Encryption passphrase'));
      console.error(pc.dim('  This is a secret phrase used to encrypt your memory data before it leaves your'));
      console.error(pc.dim('  computer. The server never sees it. Choose anything memorable — e.g. "blue-fox-2024"'));
      console.error(pc.dim('  or "correct horse battery staple". You\'ll need it on every machine you sync from.'));
      if (isNewAccount) {
        console.error(pc.dim('  Write it down — if you forget it you cannot decrypt your existing cloud data.'));
      }
      console.error('');
      const passphrase = await askQuestion('Encryption passphrase: ', true);

      if (!passphrase) {
        console.error(pc.red('Passphrase is required.'));
        process.exit(1);
      }

      writeAuthConfig({ endpoint, apiToken: token, encryptionPassphrase: passphrase });
      console.log(pc.green('✓'), `Credentials saved to ${pc.dim(AUTH_CONFIG_PATH)}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  ${pc.cyan('memory sync')}  — merge latest cloud memory and upload this workspace`);
      console.log(`  ${pc.cyan('memory sync start')}  — keep this workspace synced in the background`);
      console.log(`  ${pc.cyan('memory init --hooks')}  — enable automatic checkpointing and sync`);
    } catch (err) {
      console.error(pc.red('Error:'), (err as Error).message);
      process.exit(1);
    }
  });

// ─── push ───────────────────────────────────────────────────────────────────

syncCommand
  .command('push')
  .description('Push summaries and metadata to the cloud (E2E encrypted)')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { path?: string }) => {
    const ctx = createSyncContext(options.path);
    if (!ctx) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    console.log(pc.bold('Pushing memory to cloud…'));
    try {
      await runPushPhase(ctx);
    } catch (err) {
      console.error(pc.red('Push failed:'), (err as Error).message);
      process.exit(1);
    } finally {
      ctx.db.close();
    }
  });

// ─── pull ───────────────────────────────────────────────────────────────────

syncCommand
  .command('pull')
  .description('Pull latest memory from the cloud and merge into local DB')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { path?: string }) => {
    const ctx = createSyncContext(options.path);
    if (!ctx) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    console.log(pc.bold('Pulling memory from cloud…'));
    try {
      await runPullPhase(ctx);
    } catch (err) {
      console.error(pc.red('Pull failed:'), (err as Error).message);
      process.exit(1);
    } finally {
      ctx.db.close();
    }
  });

// ─── background sync ───────────────────────────────────────────────────────

syncCommand
  .command('start')
  .description('Start automatic background sync for this project')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .option('--interval <seconds>', 'Sync interval in seconds', '120')
  .action(async (options: { path?: string; interval: string }) => {
    const auth = readAuthConfig();
    if (!auth) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    const projectPath = options.path ?? findProjectRoot();
    const intervalSeconds = Math.max(30, Number.parseInt(options.interval, 10) || 120);
    const existing = readDaemonState(projectPath);

    const initialSync = await runAutoSync(projectPath, { exitOnError: false });
    if (!initialSync) process.exit(1);

    if (existing && isProcessRunning(existing.pid)) {
      console.log(pc.green('✓'), `Background sync already running (${existing.pid}).`);
      console.log(pc.dim(`  interval: ${existing.intervalSeconds}s`));
      return;
    }

    clearDaemonState(projectPath);
    const child = spawn(
      process.execPath,
      [process.argv[1], 'sync', 'daemon', '--path', projectPath, '--interval', String(intervalSeconds)],
      {
        cwd: projectPath,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    child.unref();

    const state: DaemonState = {
      pid: child.pid ?? 0,
      projectPath,
      intervalSeconds,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(daemonStatePath(projectPath), JSON.stringify(state, null, 2) + '\n', 'utf-8');

    console.log(pc.green('✓'), `Background sync started (${state.pid}).`);
    console.log(pc.dim(`  interval: ${intervalSeconds}s`));
  });

syncCommand
  .command('stop')
  .description('Stop automatic background sync for this project')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action((options: { path?: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const state = readDaemonState(projectPath);
    if (!state) {
      console.log(pc.yellow('~'), 'Background sync is not running.');
      return;
    }

    if (state.pid && isProcessRunning(state.pid)) {
      try { process.kill(state.pid, 'SIGTERM'); } catch { /* best effort */ }
    }
    clearDaemonState(projectPath);
    console.log(pc.green('✓'), 'Background sync stopped.');
  });

syncCommand
  .command('daemon')
  .description('Internal background sync loop')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .option('--interval <seconds>', 'Sync interval in seconds', '120')
  .action(async (options: { path?: string; interval: string }) => {
    const projectPath = options.path ?? findProjectRoot();
    const intervalSeconds = Math.max(30, Number.parseInt(options.interval, 10) || 120);

    const tick = async () => {
      await runAutoSync(projectPath, { quiet: true, exitOnError: false });
    };

    process.on('SIGTERM', () => {
      clearDaemonState(projectPath);
      process.exit(0);
    });
    process.on('SIGINT', () => {
      clearDaemonState(projectPath);
      process.exit(0);
    });

    await tick();
    setInterval(tick, intervalSeconds * 1000);
  });

// ─── restore ────────────────────────────────────────────────────────────────

syncCommand
  .command('restore')
  .description('Restore a specific checkpoint from the cloud by blob ID')
  .argument('<blob-id>', 'The checkpoint blob ID to restore (from `memory sync history` or the dashboard)')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (blobId: string, options: { path?: string }) => {
    const auth = readAuthConfig();
    if (!auth) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    const projectPath = options.path ?? findProjectRoot();
    const { db, workspace } = resolveProject(projectPath);
    const encryptionKey = deriveKey(auth.encryptionPassphrase, workspace.id);

    console.log(pc.bold(`Restoring checkpoint ${pc.cyan(blobId.slice(0, 8) + '…')}`));
    try {
      const result = await pullSync(db, {
        endpoint: auth.endpoint,
        apiToken: auth.apiToken,
        encryptionKey,
        workspaceId: workspace.id,
        blobId,
      });

      if (result.merged.sessions === 0 && result.merged.messages === 0 && result.merged.checkpoints === 0 && result.merged.decisions === 0 && result.merged.tasks === 0) {
        console.log(pc.yellow('~'), 'Nothing new to restore — this checkpoint matches your current state.');
      } else {
        console.log(pc.green('✓'), `Restored: ${pc.cyan(String(result.merged.sessions))} sessions,`, `${pc.cyan(String(result.merged.messages))} messages,`, `${pc.cyan(String(result.merged.checkpoints))} checkpoints,`, `${pc.cyan(String(result.merged.decisions))} decisions,`, `${pc.cyan(String(result.merged.tasks))} tasks`);
      }
      console.log(pc.dim(`  blob: ${blobId}`));
    } catch (err) {
      console.error(pc.red('Restore failed:'), (err as Error).message);
      process.exit(1);
    }
  });

// ─── status ─────────────────────────────────────────────────────────────────

syncCommand
  .command('status')
  .description('Show cloud sync status for this workspace')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { path?: string }) => {
    const auth = readAuthConfig();
    if (!auth) {
      console.log(noAuthMsg());
      return;
    }

    const projectPath = options.path ?? findProjectRoot();
    const { db, workspace } = resolveProject(projectPath);

    try {
      const res = await fetch(
        `${auth.endpoint}/v1/sync/status?workspaceId=${encodeURIComponent(workspace.id)}`,
        { headers: { Authorization: `Bearer ${auth.apiToken}`, 'User-Agent': CLI_UA } },
      );

      if (res.status === 404) {
        console.log(pc.yellow('~'), 'This workspace has not been synced yet.');
        console.log(`  Run ${pc.cyan('memory sync')} to start.`);
        return;
      }

      if (res.status === 402) {
        console.log(pc.yellow('Pro subscription required.'), `Upgrade at ${pc.cyan('https://memcode.pro/pricing')}`);
        return;
      }

      if (!res.ok) {
        console.error(pc.red('Status check failed:'), res.status);
        return;
      }

      const data = (await res.json()) as {
        lastSyncedAt: string | null;
        cursor: string;
        totalPushes: number;
      };

      const when = data.lastSyncedAt
        ? new Date(data.lastSyncedAt).toLocaleString()
        : 'never';
      console.log(pc.bold('Cloud sync status'));
      console.log(`  Workspace:    ${pc.cyan(workspace.id.slice(0, 8) + '…')}`);
      console.log(`  Last synced:  ${pc.cyan(when)}`);
      console.log(`  Total pushes: ${pc.cyan(String(data.totalPushes))}`);
      console.log(`  Endpoint:     ${pc.dim(auth.endpoint)}`);
      const daemon = readDaemonState(projectPath);
      if (daemon && isProcessRunning(daemon.pid)) {
        console.log(`  Background:   ${pc.green('running')} (${daemon.pid}, every ${daemon.intervalSeconds}s)`);
      } else {
        if (daemon) clearDaemonState(projectPath);
        console.log(`  Background:   ${pc.dim('stopped')}`);
      }
    } catch (err) {
      console.error(pc.red('Error:'), (err as Error).message);
    }
  });

// ─── set-password ───────────────────────────────────────────────────────────

syncCommand
  .command('set-password')
  .description('Change your MemCode account password')
  .action(async () => {
    const auth = readAuthConfig();
    if (!auth) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    console.error(pc.bold('\nMemCode Cloud — change password\n'));

    try {
      const currentPassword = await askQuestion('Current password: ', true);
      const newPassword     = await askQuestion('New password (min 8 chars): ', true);
      const confirmPassword = await askQuestion('Confirm new password: ', true);

      if (newPassword !== confirmPassword) {
        console.error(pc.red('✗'), 'Passwords do not match.');
        process.exit(1);
      }
      if (newPassword.length < 8) {
        console.error(pc.red('✗'), 'New password must be at least 8 characters.');
        process.exit(1);
      }

      const endpoint = auth.endpoint.replace(/\/$/, '');
      const res = await fetch(`${endpoint}/v1/user/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': CLI_UA,
          Authorization: `Bearer ${auth.apiToken}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (res.ok) {
        console.log(pc.green('✓'), 'Password changed successfully.');
        console.log(pc.dim('  Your encryption passphrase is unchanged — existing cloud data remains accessible.'));
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(pc.red('✗'), body.error ?? `Request failed (${res.status})`);
        process.exit(1);
      }
    } catch (err) {
      console.error(pc.red('Error:'), (err as Error).message);
      process.exit(1);
    }
  });

// ─── logout ──────────────────────────────────────────────────────────────────

syncCommand
  .command('logout')
  .description('Clear locally stored cloud credentials')
  .action(() => {
    if (!existsSync(AUTH_CONFIG_PATH)) {
      console.log(pc.yellow('~'), 'No credentials stored — already logged out.');
      return;
    }
    try {
      unlinkSync(AUTH_CONFIG_PATH);
      console.log(pc.green('✓'), 'Logged out — credentials cleared.');
      console.log(pc.dim(`  Run ${pc.cyan('memory sync auth')} to authenticate again.`));
    } catch (err) {
      console.error(pc.red('Error:'), (err as Error).message);
      process.exit(1);
    }
  });

// ─── whoami ──────────────────────────────────────────────────────────────────

syncCommand
  .command('whoami')
  .description('Show the current cloud authentication state')
  .action(async () => {
    const auth = readAuthConfig();
    if (!auth) {
      console.log(pc.yellow('Not logged in.'));
      console.log(`  Run ${pc.cyan('memory sync auth')} to authenticate.`);
      return;
    }

    try {
      const res = await fetch(`${auth.endpoint.replace(/\/$/, '')}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${auth.apiToken}`, 'User-Agent': CLI_UA },
      });

      if (res.ok) {
        const { email } = (await res.json()) as { email: string };
        console.log(pc.green('✓'), 'Authenticated as', pc.cyan(email));
        console.log(`  Endpoint : ${pc.dim(auth.endpoint)}`);
        console.log(`  Config   : ${pc.dim(AUTH_CONFIG_PATH)}`);
      } else if (res.status === 401) {
        console.log(pc.red('✗'), 'Token expired or revoked.');
        console.log(`  Run ${pc.cyan('memory sync auth')} to re-authenticate.`);
      } else {
        console.log(pc.yellow('~'), `Server returned ${res.status} — could not verify token.`);
        console.log(`  Endpoint : ${pc.dim(auth.endpoint)}`);
      }
    } catch {
      // Offline / unreachable
      console.log(pc.yellow('~'), 'Cannot reach server — showing local credentials.');
      console.log(`  Endpoint : ${pc.dim(auth.endpoint)}`);
      console.log(`  Config   : ${pc.dim(AUTH_CONFIG_PATH)}`);
    }
  });

function noAuthMsg(): string {
  return `
${pc.yellow('Not authenticated.')}

Run ${pc.cyan('memory sync auth')} to link your CLI to a MemCode Pro account.

Don't have an account? Sign up at ${pc.cyan('https://memcode.pro/pricing')} ($3.99/month).
`;
}

