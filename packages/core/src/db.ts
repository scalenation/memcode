import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

/**
 * Open (or create) a MemCode SQLite database at the given path,
 * run any pending migrations, and return the connection.
 *
 * The connection is configured with WAL mode and foreign key enforcement.
 * Requires Node.js >= 22.15.0 (stable node:sqlite built-in).
 */
export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);

  // Recommended pragmas for safety and performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  runMigrations(db);

  return db;
}

/**
 * Run a function inside a SQLite transaction. Commits on success, rolls back
 * on any thrown error. Equivalent to better-sqlite3's db.transaction(fn)().
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function runMigrations(db: DatabaseSync): void {
  // Bootstrap the migrations registry table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);

  const checkApplied = db.prepare('SELECT id FROM migrations WHERE name = ?');
  const markApplied = db.prepare(
    'INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const migration of MIGRATIONS) {
    const already = checkApplied.get(migration.name) as unknown as { id: number } | undefined;
    if (!already) {
      db.exec(migration.sql);
      markApplied.run(migration.name, Date.now());
    }
  }
}

/**
 * Return the names of all applied migrations.
 */
export function appliedMigrations(db: DatabaseSync): string[] {
  try {
    return (db
      .prepare('SELECT name FROM migrations ORDER BY id')
      .all() as { name: string }[])
      .map((r) => r.name);
  } catch {
    return [];
  }
}
