import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { openDb } from '../src/db';
import { getOrCreateWorkspace } from '../src/workspace';
import { recall, recallSync } from '../src/retrieval';
import { createDecision } from '../src/items';
import { createCheckpointSync } from '../src/checkpoint';
import type Database from 'better-sqlite3';

let tmpDir: string;
let db: Database.Database;
let workspaceId: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `memcode-retrieval-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  db = openDb(join(tmpDir, 'memory.db'));
  workspaceId = getOrCreateWorkspace(db, tmpDir).id;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('recall()', () => {
  it('returns empty array when there is no data', () => {
    expect(recallSync(db, workspaceId, 'anything', 10)).toEqual([]);
  });

  it('returns empty array for empty query', () => {
    createDecision(db, {
      workspaceId,
      title: 'Use SQLite',
      rationale: 'Simpler than PostgreSQL for local-first apps',
    });
    expect(recallSync(db, workspaceId, '', 10)).toEqual([]);
  });

  it('matches a decision by keyword in title', () => {
    createDecision(db, {
      workspaceId,
      title: 'Use SQLite for local storage',
      rationale: 'Keeps the footprint small',
    });

    const results = recallSync(db, workspaceId, 'sqlite', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('decision');
    expect(results[0].title.toLowerCase()).toContain('sqlite');
  });

  it('matches a checkpoint by keyword in summary', () => {
    createCheckpointSync(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'manual',
      note: 'Migrated to TypeScript',
    });

    const results = recallSync(db, workspaceId, 'typescript', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('checkpoint');
  });

  it('ranks decisions higher than checkpoints for the same keyword', () => {
    // decision has type_boost 1.5 vs checkpoint 1.0
    createDecision(db, {
      workspaceId,
      title: 'database choice',
      rationale: 'chose SQLite over Postgres',
    });
    createCheckpointSync(db, {
      workspaceId,
      projectPath: tmpDir,
      trigger: 'manual',
      note: 'database migration completed',
    });

    const results = recallSync(db, workspaceId, 'database', 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].type).toBe('decision');
  });

  it('does not return items that have zero keyword overlap', () => {
    createDecision(db, {
      workspaceId,
      title: 'Use Redis caching',
      rationale: 'Speed up reads',
    });

    const results = recallSync(db, workspaceId, 'unrelated obscure xyz', 10);
    expect(results).toEqual([]);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 10; i++) {
      createDecision(db, {
        workspaceId,
        title: `Decision about auth ${i}`,
        rationale: 'auth is important',
      });
    }
    const results = recallSync(db, workspaceId, 'auth', 3);
    expect(results.length).toBe(3);
  });
});
