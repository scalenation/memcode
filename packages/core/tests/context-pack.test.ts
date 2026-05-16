import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { openDb } from '../src/db';
import { getOrCreateWorkspace } from '../src/workspace';
import { generateContextPack } from '../src/context-pack';
import { createCheckpointSync } from '../src/checkpoint';
import { createDecision } from '../src/items';
import { createTask } from '../src/items';
import type { DatabaseSync } from 'node:sqlite';

let tmpDir: string;
let db: DatabaseSync;
let workspaceId: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `memcode-contextpack-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  db = openDb(join(tmpDir, 'memory.db'));
  workspaceId = getOrCreateWorkspace(db, tmpDir).id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateContextPack()', () => {
  it('generates a context pack header with project name', () => {
    const pack = generateContextPack(db, workspaceId);
    expect(pack).toContain('Project Memory Context');
  });

  it('includes the latest checkpoint summary', () => {
    createCheckpointSync(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'manual',
      note: 'Initial architecture design',
    });

    const pack = generateContextPack(db, workspaceId);
    expect(pack).toContain('Current State');
    expect(pack).toContain('Initial architecture design');
  });

  it('includes active tasks', () => {
    createTask(db, {
      workspaceId,
      title: 'Implement OAuth flow',
      priority: 'high',
    });

    const pack = generateContextPack(db, workspaceId);
    expect(pack).toContain('Active Tasks');
    expect(pack).toContain('Implement OAuth flow');
  });

  it('includes key decisions', () => {
    createDecision(db, {
      workspaceId,
      title: 'Use PostgreSQL',
      rationale: 'Better concurrency support',
      impact: 'All data services must use the pg driver',
    });

    const pack = generateContextPack(db, workspaceId);
    expect(pack).toContain('Key Decisions');
    expect(pack).toContain('Use PostgreSQL');
  });

  it('includes recent AI session breadcrumbs when session history exists', () => {
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, editor, agent, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', workspaceId, 'VS Code', 'GitHub Copilot', 1000, 3000);

    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('msg-1', 'sess-1', 'user', 'Figure out why OAuth callback fails after login.', 10, 1500);

    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('msg-2', 'sess-1', 'assistant', 'Patched redirect URI handling and updated the callback route.', 12, 2500);

    const pack = generateContextPack(db, workspaceId);
    expect(pack).toContain('Recent AI Sessions');
    expect(pack).toContain('GitHub Copilot');
    expect(pack).toContain('User intent: Figure out why OAuth callback fails after login.');
    expect(pack).toContain('Assistant outcome: Patched redirect URI handling and updated the callback route.');
  });

  it('does not include done tasks in active section', () => {
    const task = createTask(db, { workspaceId, title: 'Done task' });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);

    const pack = generateContextPack(db, workspaceId);
    // 'Active Tasks' section should be absent or not contain the done task
    if (pack.includes('Active Tasks')) {
      expect(pack).not.toContain('Done task');
    }
  });

  it('throws for unknown workspace id', () => {
    expect(() => generateContextPack(db, 'nonexistent-id')).toThrow();
  });

  it('completes in reasonable time (performance smoke test)', () => {
    // Insert some data
    for (let i = 0; i < 50; i++) {
      createDecision(db, {
        workspaceId,
        title: `Decision ${i}`,
        rationale: 'Lorem ipsum dolor sit amet',
      });
    }
    const start = Date.now();
    generateContextPack(db, workspaceId);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // < 500 ms target from spec
  });
});
