import { DatabaseSync } from 'node:sqlite';
import { parseLaunchCommand, type Elevation, type LaunchCommand, type ShellKind } from '@vesper/protocol';

export interface SessionRecord {
  id: string;
  shell: ShellKind | null;
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
  /** What runs instead of a shell; exactly one of shell and command is set. */
  command: LaunchCommand | null;
  /** Restarts run with the same privilege. */
  elevation: Elevation;
}

export type SessionChanges = Partial<Omit<SessionRecord, 'id' | 'shell' | 'command' | 'createdAt' | 'elevation'>>;
type Row = Omit<SessionRecord, 'command'> & { command: string | null };

const SCHEMA_VERSION = 3;
/** v3; sessions from v2 and before ran with the host's own token. */
const ELEVATION_COLUMN = `elevation TEXT NOT NULL DEFAULT 'admin' CHECK (elevation IN ('admin', 'normal'))`;
const SESSIONS_TABLE = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    shell TEXT,
    command TEXT,
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
    exited_at INTEGER,
    ${ELEVATION_COLUMN},
    CHECK ((shell IS NULL) <> (command IS NULL))
  )`;
/** v1 had only shells; its columns are a subset of v2's. */
const V1_COLUMNS = 'id, shell, title, osc_title, cwd, last_cwd, status, exit_code, inc, cols, rows, created_at, exited_at';
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
  command: 'command',
  elevation: 'elevation',
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
    const command = record.command === null ? null : JSON.stringify(record.command);
    this.db.prepare(`INSERT INTO sessions (${columns}) VALUES (${values})`).run({ ...record, command });
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return row && toRecord(row);
  }

  /** A row whose launch command no longer validates throws; Host.restore skips that session. */
  list(): SessionRecord[] {
    return (this.db.prepare(`${SELECT} ORDER BY created_at, id`).all() as unknown as Row[]).map(toRecord);
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
    // SQLite cannot drop a NOT NULL constraint, so v1's table is rebuilt; the version moves in the same transaction.
    const upgrade =
      version === 1
        ? `ALTER TABLE sessions RENAME TO sessions_v1; ${SESSIONS_TABLE};
           INSERT INTO sessions (${V1_COLUMNS}) SELECT ${V1_COLUMNS} FROM sessions_v1; DROP TABLE sessions_v1;`
        : version === 2
          ? `ALTER TABLE sessions ADD COLUMN ${ELEVATION_COLUMN};`
          : `${SESSIONS_TABLE};`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`${upgrade} PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function toRecord(row: Row): SessionRecord {
  return { ...row, command: row.command === null ? null : parseLaunchCommand(JSON.parse(row.command)) };
}
