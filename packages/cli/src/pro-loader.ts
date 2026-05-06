/**
 * Pro plugin loader — called at CLI startup.
 *
 * If @memcode/pro is installed (npm install -g @memcode/pro), this module
 * loads it and activates its providers before any command runs.
 *
 * The OSS CLI has no compile-time dependency on @memcode/pro. The require()
 * is fully dynamic and silent-fails when the package is not installed.
 *
 * Authentication config is read from ~/.memcode/auth.json (written by
 * `memory sync auth` after the user subscribes).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface AuthConfig {
  apiEndpoint: string;
  apiToken: string;
  workspaceId: string;
}

export function loadProPlugin(workspaceId: string): void {
  // 1. Check auth config exists
  const authPath = join(homedir(), '.memcode', 'auth.json');
  if (!existsSync(authPath)) return;

  let auth: AuthConfig;
  try {
    auth = JSON.parse(readFileSync(authPath, 'utf-8')) as AuthConfig;
    if (!auth.apiToken || !auth.apiEndpoint) return;
  } catch {
    return;
  }

  // 2. Dynamically require @memcode/pro (absent in OSS installs)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pro = require('@memcode/pro') as {
      activate: (opts: AuthConfig) => void;
    };
    pro.activate({ ...auth, workspaceId });
  } catch {
    // @memcode/pro not installed — continue with free tier
  }
}
