import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SessionStore, type SessionRecord } from '../src/store.js';

const record = (id: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  shell: 'powershell',
  title: '',
  oscTitle: '',
  cwd: 'D:\\code',
  lastCwd: 'D:\\code',
  status: 'running',
  exitCode: null,
  inc: 1,
  cols: 120,
  rows: 30,
  createdAt: 1000,
  exitedAt: null,
  command: null,
  elevation: 'admin',
  agentSessionId: null,
  ...overrides,
});

const V1_SCHEMA = `
  CREATE TABLE sessions (
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
  PRAGMA user_version = 1;
`;
const claude = { file: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: ['--model', 'opus'], env: { A: '1' }, label: 'Claude' };

describe('SessionStore', () => {
  const dirs: string[] = [];
  const stores: SessionStore[] = [];
  const open = (dir = mkdtempSync(join(tmpdir(), 'vesper-store-'))): { store: SessionStore; path: string } => {
    dirs.push(dir);
    const store = new SessionStore(join(dir, 'host.db'));
    stores.push(store);
    return { store, path: join(dir, 'host.db') };
  };

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('stores and lists sessions in creation order', () => {
    const { store } = open();
    store.insert(record('b', { createdAt: 2000 }));
    store.insert(record('a', { createdAt: 1000, title: '构建', cwd: 'D:\\代码' }));
    expect(store.list().map((row) => row.id)).toEqual(['a', 'b']);
    expect(store.get('a')).toEqual(record('a', { title: '构建', cwd: 'D:\\代码' }));
    expect(store.get('missing')).toBeUndefined();
  });

  test('updates only the given fields', () => {
    const { store } = open();
    store.insert(record('a'));
    store.update('a', { status: 'exited', exitCode: 3, exitedAt: 5000, lastCwd: 'C:\\', title: undefined });
    expect(store.get('a')).toEqual(record('a', { status: 'exited', exitCode: 3, exitedAt: 5000, lastCwd: 'C:\\' }));
    store.update('a', {});
  });

  test('treats hostile values as data', () => {
    const { store } = open();
    store.insert(record('a'));
    store.update('a', { title: "x'; DROP TABLE sessions; --" });
    expect(store.get('a')?.title).toBe("x'; DROP TABLE sessions; --");
    expect(store.list()).toHaveLength(1);
  });

  test('deletes sessions', () => {
    const { store } = open();
    store.insert(record('a'));
    store.delete('a');
    expect(store.list()).toEqual([]);
  });

  test('keeps data across reopening', () => {
    const { store, path } = open();
    store.insert(record('a'));
    store.close();
    stores.splice(0);
    const reopened = new SessionStore(path);
    stores.push(reopened);
    expect(reopened.list()).toHaveLength(1);
  });

  test('stores a launch command in place of a shell', () => {
    const { store } = open();
    store.insert(record('a', { shell: null, command: claude }));
    store.insert(record('b', { shell: null, command: { commandLine: 'npm run dev', label: '开发' }, createdAt: 2000 }));
    expect(store.list()).toEqual([
      record('a', { shell: null, command: claude }),
      record('b', { shell: null, command: { commandLine: 'npm run dev', label: '开发' }, createdAt: 2000 }),
    ]);
  });

  test('needs exactly one of a shell and a launch command', () => {
    const { store } = open();
    expect(() => store.insert(record('a', { shell: null }))).toThrow();
    expect(() => store.insert(record('b', { command: claude }))).toThrow();
  });

  test('upgrades a v1 database and keeps its sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-store-'));
    dirs.push(dir);
    const path = join(dir, 'host.db');
    const raw = new DatabaseSync(path);
    raw.exec(V1_SCHEMA);
    raw
      .prepare("INSERT INTO sessions VALUES ('a', 'cmd', '构建', 'osc', 'D:\\code', 'D:\\code', 'exited', 3, 2, 100, 30, 1000, 5000)")
      .run();
    raw.close();
    const store = new SessionStore(path);
    stores.push(store);
    expect(store.list()).toEqual([
      record('a', { shell: 'cmd', title: '构建', oscTitle: 'osc', status: 'exited', exitCode: 3, inc: 2, cols: 100, exitedAt: 5000 }),
    ]);
    store.insert(record('b', { shell: null, command: claude, createdAt: 2000 }));
    expect(store.list()).toHaveLength(2);
  });

  test('a v2 database gains the elevation column; its sessions ran as admin', () => {
    const { store, path } = open();
    store.insert(record('a', { elevation: 'normal' }));
    store.close();
    stores.splice(0);
    const raw = new DatabaseSync(path);
    raw.exec('ALTER TABLE sessions DROP COLUMN elevation; ALTER TABLE sessions DROP COLUMN agent_session_id; PRAGMA user_version = 2;');
    raw.close();
    const reopened = new SessionStore(path);
    stores.push(reopened);
    expect(reopened.get('a')?.elevation).toBe('admin');
  });

  test('refuses a database from a newer version', () => {
    const { store, path } = open();
    store.close();
    stores.splice(0);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => new SessionStore(path)).toThrow(/schema v99/);
  });
});
