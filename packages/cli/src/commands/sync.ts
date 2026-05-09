import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { pushSync, pullSync, deriveKey } from '@memcode/cloud-client';
import { findProjectRoot, resolveProject } from '../util';

const DEFAULT_ENDPOINT = 'https://api.memcode.pro';
const AUTH_CONFIG_PATH = join(homedir(), '.config', 'memcode', 'auth.json');

interface AuthConfig {
  endpoint: string;
  apiToken: string;
  encryptionPassphrase: string;
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

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return rl.question(question);
}

export const syncCommand = new Command('sync').description(
  'Sync project memory with the cloud (Pro feature — memcode.pro/pricing)',
);

// ─── auth ───────────────────────────────────────────────────────────────────

syncCommand
  .command('auth')
  .description('Authenticate with the MemCode cloud and save credentials locally')
  .option('--endpoint <url>', 'API endpoint', DEFAULT_ENDPOINT)
  .action(async (options: { endpoint: string }) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    console.error(pc.bold('\nMemCode Cloud — authenticate\n'));

    try {
      const email = await prompt(rl, 'Email: ');
      process.stderr.write('Password: ');
      // Hide password input
      const password = await new Promise<string>((resolve) => {
        let pwd = '';
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf-8');
        const onData = (ch: Buffer | string) => {
          const char = ch.toString();
          if (char === '\r' || char === '\n') {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
            process.stderr.write('\n');
            resolve(pwd);
          } else if (char === '\u0003') {
            process.exit(0);
          } else if (char === '\u007f') {
            pwd = pwd.slice(0, -1);
          } else {
            pwd += char;
          }
        };
        process.stdin.on('data', onData);
      });

      const passphrase = await prompt(rl, 'Encryption passphrase (used to encrypt your memory — remember this): ');
      rl.close();

      if (!email || !password || !passphrase) {
        console.error(pc.red('All fields are required.'));
        process.exit(1);
      }

      // Try login first, then register if account doesn't exist
      const endpoint = options.endpoint.replace(/\/$/, '');
      let token: string | null = null;

      const loginRes = await fetch(`${endpoint}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (loginRes.ok) {
        const body = (await loginRes.json()) as { token: string };
        token = body.token;
        console.log(pc.green('✓'), 'Logged in as', pc.cyan(email));
      } else if (loginRes.status === 401) {
        // Try registering
        const registerRes = await fetch(`${endpoint}/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (registerRes.ok) {
          const body = (await registerRes.json()) as { token: string };
          token = body.token;
          console.log(pc.green('✓'), 'Account created for', pc.cyan(email));
        } else {
          const err = (await registerRes.json().catch(() => ({}) )) as { error?: string };
          console.error(pc.red('✗'), err.error ?? 'Registration failed');
          process.exit(1);
        }
      } else {
        const err = (await loginRes.json().catch(() => ({}))) as { error?: string };
        console.error(pc.red('✗'), err.error ?? 'Authentication failed');
        process.exit(1);
      }

      if (!token) {
        console.error(pc.red('Failed to obtain auth token.'));
        process.exit(1);
      }

      writeAuthConfig({ endpoint, apiToken: token, encryptionPassphrase: passphrase });
      console.log(pc.green('✓'), `Credentials saved to ${pc.dim(AUTH_CONFIG_PATH)}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  ${pc.cyan('memory sync push')}  — push this workspace to the cloud`);
      console.log(`  ${pc.cyan('memory sync pull')}  — pull on another machine`);
    } catch (err) {
      rl.close();
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
    const auth = readAuthConfig();
    if (!auth) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    const projectPath = options.path ?? findProjectRoot();
    const { db, workspace } = resolveProject(projectPath);
    const encryptionKey = deriveKey(auth.encryptionPassphrase, workspace.id);

    console.log(pc.bold('Pushing memory to cloud…'));
    try {
      const result = await pushSync(db, {
        endpoint: auth.endpoint,
        apiToken: auth.apiToken,
        encryptionKey,
        workspaceId: workspace.id,
      });
      console.log(pc.green('✓'), `Pushed ${pc.cyan(String(result.checkpointsCount))} checkpoints,`, `${pc.cyan(String(result.decisionsCount))} decisions,`, `${pc.cyan(String(result.tasksCount))} tasks`);
      console.log(pc.dim(`  cursor: ${result.cursor}`));
    } catch (err) {
      console.error(pc.red('Push failed:'), (err as Error).message);
      process.exit(1);
    }
  });

// ─── pull ───────────────────────────────────────────────────────────────────

syncCommand
  .command('pull')
  .description('Pull latest memory from the cloud and merge into local DB')
  .option('--path <path>', 'Project path (defaults to current working directory)')
  .action(async (options: { path?: string }) => {
    const auth = readAuthConfig();
    if (!auth) {
      console.log(noAuthMsg());
      process.exit(1);
    }

    const projectPath = options.path ?? findProjectRoot();
    const { db, workspace } = resolveProject(projectPath);
    const encryptionKey = deriveKey(auth.encryptionPassphrase, workspace.id);

    console.log(pc.bold('Pulling memory from cloud…'));
    try {
      const result = await pullSync(db, {
        endpoint: auth.endpoint,
        apiToken: auth.apiToken,
        encryptionKey,
        workspaceId: workspace.id,
      });

      if (result.merged.checkpoints === 0 && result.merged.decisions === 0 && result.merged.tasks === 0) {
        console.log(pc.green('✓'), 'Already up to date.');
      } else {
        console.log(pc.green('✓'), `Merged ${pc.cyan(String(result.merged.checkpoints))} checkpoints,`, `${pc.cyan(String(result.merged.decisions))} decisions,`, `${pc.cyan(String(result.merged.tasks))} tasks`);
      }
      console.log(pc.dim(`  cursor: ${result.cursor}`));
    } catch (err) {
      console.error(pc.red('Pull failed:'), (err as Error).message);
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
        { headers: { Authorization: `Bearer ${auth.apiToken}` } },
      );

      if (res.status === 404) {
        console.log(pc.yellow('~'), 'This workspace has not been synced yet.');
        console.log(`  Run ${pc.cyan('memory sync push')} to start.`);
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
    } catch (err) {
      console.error(pc.red('Error:'), (err as Error).message);
    }
  });

function noAuthMsg(): string {
  return `
${pc.yellow('Not authenticated.')}

Run ${pc.cyan('memory sync auth')} to link your CLI to a MemCode Pro account.

Don't have an account? Sign up at ${pc.cyan('https://memcode.pro/pricing')} ($3.99/month).
`;
}

