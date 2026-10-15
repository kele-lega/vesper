import { DatabaseSync } from 'node:sqlite';
import type { ShellKind } from '@vesper/protocol';

export interface SessionRecord {
  id: string;
  shell: ShellKind;
  /** Title the user gave the session; empty when unset. */
  title: string;
  /** Last title the shell or a program set (OSC 0/2). */
  oscTitle: string;
  /** Directory the session was created in. */
  cwd: string;
  /** Last directory the shell reported; restarts begin here. */
  lastCwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  inc: number;
  cols: number;
  rows: number;
  createdAt: number;
  exitedAt: number | null;
}

export type SessionChanges = Partial<Omit<SessionRecord, 'id' | 'shell' | 'createdAt'>>;

const SCHEMA_VERSION = 1;
const COLUMNS: Record<keyof SessionRecord, string> = {
  id: 'id',
  shell: 'shell',
  title: 'title',
  oscTitle: 'osc_title',
  cwd: 'cwd',
  lastCwd: 'last_cwd',
  status: 'status',
  exitCode: 'exit_code',
  inc: 'inc',
  cols: 'cols',
  rows: 'rows',
  createdAt: 'created_at',
  exitedAt: 'exited_at',
};
const FIELDS = Object.keys(COLUMNS) as (keyof SessionRecord)[];
const SELECT = `SELECT ${FIELDS.map((field) => `${COLUMNS[field]} AS ${field}`).join(', ')} FROM sessions`;

/** The host's session registry, in SQLite (WAL) so it survives crashes and reboots. */
export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  insert(record: SessionRecord): void {
    const columns = FIELDS.map((field) => COLUMNS[field]).join(', ');
    const values = FIELDS.map((field) => `:${field}`).join(', ');
    this.db.prepare(`INSERT INTO sessions (${columns}) VALUES (${values})`).run({ ...record });
  }

  get(id: string): SessionRecord | undefined {
    return this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as SessionRecord | undefined;
  }

  list(): SessionRecord[] {
    return this.db.prepare(`${SELECT} ORDER BY created_at, id`).all() as unknown as SessionRecord[];
  }

  update(id: string, changes: SessionChanges): void {
    const fields = (Object.keys(changes) as (keyof SessionChanges)[]).filter((field) => changes[field] !== undefined);
    if (fields.length === 0) return;
    // Column names come from the fixed COLUMNS table, never from the caller; values are bound.
    const assignments = fields.map((field) => `${COLUMNS[field]} = :${field}`).join(', ');
    const values = Object.fromEntries(fields.map((field) => [field, changes[field] as string | number | null]));
    this.db.prepare(`UPDATE sessions SET ${assignments} WHERE id = :id`).run({ ...values, id });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) throw new Error(`session store is schema v${version}; this host knows v${SCHEMA_VERSION}`);
    if (version === SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        shell TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        osc_title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        last_cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'exited')),
        exit_code INTEGER,
        inc INTEGER NOT NULL,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        exited_at INTEGER
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
}
