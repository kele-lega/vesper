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
  ...overrides,
});

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
