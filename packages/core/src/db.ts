import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

/**
 * Open (or create) a MemCode SQLite database at the given path,
 * run any pending migrations, and return the connection.
 *
 * The connection is configured with WAL mode and foreign key enforcement.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Recommended pragmas for safety and performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  // Bootstrap the migrations registry table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);

  const checkApplied = db.prepare<[string], { id: number }>(
    'SELECT id FROM migrations WHERE name = ?',
  );
  const markApplied = db.prepare(
    'INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const migration of MIGRATIONS) {
    const already = checkApplied.get(migration.name);
    if (!already) {
      db.exec(migration.sql);
      markApplied.run(migration.name, Date.now());
    }
  }
}

/**
 * Return the names of all applied migrations.
 */
export function appliedMigrations(db: Database.Database): string[] {
  try {
    return (
      db
        .prepare<[], { name: string }>('SELECT name FROM migrations ORDER BY id')
        .all() as { name: string }[]
    ).map((r) => r.name);
  } catch {
    return [];
  }
}
