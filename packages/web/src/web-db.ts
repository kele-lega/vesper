import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * vesper-web's own database: login, devices and settings (projects, tabs and
 * profiles follow). Each entry upgrades the schema by one version; released
 * entries are never edited, new ones are appended.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE auth (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, changed_at INTEGER NOT NULL);
   CREATE TABLE devices (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     last_ip TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE COLLATE NOCASE,
     position INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE profiles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     shell TEXT,
     command TEXT,
     agent TEXT CHECK (agent IN ('claude', 'codex', 'gemini')),
     elevation TEXT NOT NULL CHECK (elevation IN ('admin', 'normal')),
     source TEXT NOT NULL CHECK (source IN ('builtin', 'wt', 'user')),
     wt_guid TEXT,
     position INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     CHECK ((shell IS NULL) <> (command IS NULL))
   );
   CREATE TABLE tabs (
     session_id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
     profile_id TEXT REFERENCES profiles (id) ON DELETE SET NULL,
     name TEXT NOT NULL DEFAULT '',
     position INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX tabs_by_project ON tabs (project_id, position);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     at INTEGER NOT NULL,
     read INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX events_by_time ON events (at);`,
];
const BUSY_TIMEOUT_MS = 5000;

export function webDatabasePath(home: string): string {
  return join(home, 'web', 'vesper.db');
}

/** Opens (creating if needed) and migrates the database; the CLI and the server may both have it open. */
export function openWebDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  // The version is read inside the write transaction, so two processes starting together migrate once.
  inTransaction(db, () => {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > MIGRATIONS.length) throw new Error(`web database is schema v${version}; this server knows v${MIGRATIONS.length}`);
    for (const step of MIGRATIONS.slice(version)) db.exec(step);
    if (version < MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });
}

/** Runs `work` in one write transaction; called inside one already, it joins it. */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
