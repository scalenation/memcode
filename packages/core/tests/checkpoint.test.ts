import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { openDb } from '../src/db';
import { getOrCreateWorkspace } from '../src/workspace';
import { createCheckpoint, listCheckpoints } from '../src/checkpoint';
import type Database from 'better-sqlite3';

let tmpDir: string;
let db: Database.Database;
let workspaceId: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `memcode-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  db = openDb(join(tmpDir, 'memory.db'));
  const ws = getOrCreateWorkspace(db, tmpDir);
  workspaceId = ws.id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createCheckpoint()', () => {
  it('persists a checkpoint and returns it', () => {
    const cp = createCheckpoint(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'manual',
      note: 'First checkpoint',
    });

    expect(cp.id).toBeTruthy();
    expect(cp.workspace_id).toBe(workspaceId);
    expect(cp.trigger).toBe('manual');
    expect(cp.summary_short).toContain('First checkpoint');
    expect(cp.summary_long).toContain('First checkpoint');
    expect(cp.created_at).toBeGreaterThan(0);
  });

  it('redacts secrets in the note before persisting', () => {
    const cp = createCheckpoint(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'manual',
      note: 'Added api_key=sk-abcdefghijklmnopqrstuvwxyz1234 to env',
    });

    expect(cp.summary_short).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(cp.summary_short).toContain('[REDACTED]');
  });

  it('creates checkpoint without git info when not in a git repo', () => {
    // tmpDir is not a git repo — getGitInfo returns empty object
    const cp = createCheckpoint(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'pre-commit',
    });
    expect(cp.git_sha).toBeUndefined();
    expect(cp.branch).toBeUndefined();
  });

  it('appends a JSONL event file', () => {
    createCheckpoint(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'manual',
    });
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const jsonl = readFileSync(join(tmpDir, '.memory', 'events.jsonl'), 'utf-8');
    const event = JSON.parse(jsonl.trim().split('\n')[0]);
    expect(event.type).toBe('checkpoint');
    expect(event.workspace_id).toBe(workspaceId);
  });
});

describe('listCheckpoints()', () => {
  it('returns checkpoints newest first', () => {
    createCheckpoint(db, { workspaceId, projectPath: tmpDir, trigger: 'manual', note: 'First' });
    createCheckpoint(db, { workspaceId, projectPath: tmpDir, trigger: 'manual', note: 'Second' });
    createCheckpoint(db, { workspaceId, projectPath: tmpDir, trigger: 'manual', note: 'Third' });

    const list = listCheckpoints(db, workspaceId, 10);
    expect(list.length).toBe(3);
    expect(list[0].summary_short).toContain('Third');
    expect(list[2].summary_short).toContain('First');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      createCheckpoint(db, { workspaceId, projectPath: tmpDir, trigger: 'manual' });
    }
    expect(listCheckpoints(db, workspaceId, 3).length).toBe(3);
  });
});
