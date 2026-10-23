import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ProjectError, ProjectStore } from '../src/project-store.js';
import { openWebDatabase } from '../src/web-db.js';

describe('ProjectStore', () => {
  let dir: string;
  let db: DatabaseSync;
  let store: ProjectStore;
  let clock = 1000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-projects-'));
    db = openWebDatabase(join(dir, 'vesper.db'));
    store = new ProjectStore(db, () => clock++, 'win32');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('migrates case-sensitive paths without losing existing tabs or foreign-key behavior', () => {
    const path = join(dir, 'legacy.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE COLLATE NOCASE, position INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE profiles (id TEXT PRIMARY KEY);
      CREATE TABLE tabs (
        session_id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
        profile_id TEXT REFERENCES profiles (id) ON DELETE SET NULL,
        name TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, created_at INTEGER NOT NULL,
        worktree TEXT, branch TEXT
      );
      CREATE INDEX tabs_by_project ON tabs (project_id, position);
      INSERT INTO projects VALUES ('project', 'old', '/home/me/Code', 0, 1);
      INSERT INTO profiles VALUES ('profile');
      INSERT INTO tabs VALUES ('session', 'project', 'profile', 'kept', 0, 1, '/home/me/old-worktrees/fix', 'vesper/fix');
      PRAGMA user_version = 3;
    `);
    legacy.close();
    const migrated = openWebDatabase(path);
    try {
      expect(migrated.prepare('SELECT * FROM tabs').get()).toMatchObject({ session_id: 'session', project_id: 'project', profile_id: 'profile', name: 'kept', worktree: '/home/me/old-worktrees/fix', branch: 'vesper/fix' });
      expect(new ProjectStore(migrated, Date.now, 'linux').create('distinct', '/home/me/code').path).toBe('/home/me/code');
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      migrated.prepare('DELETE FROM profiles WHERE id = ?').run('profile');
      expect(migrated.prepare('SELECT profile_id FROM tabs').get()).toMatchObject({ profile_id: null });
      migrated.prepare('DELETE FROM projects WHERE id = ?').run('project');
      expect(migrated.prepare('SELECT * FROM tabs').all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  test('creates projects in order, normalizing the path', () => {
    const a = store.create('Vesper', 'D:\\code\\work_space\\vesper\\');
    const b = store.create(' 博客 ', 'D:\\blog');
    expect(a).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: 'Vesper', path: 'D:\\code\\work_space\\vesper', position: 0, createdAt: 1000 });
    expect(b).toMatchObject({ name: '博客', path: 'D:\\blog', position: 1 });
    expect(store.list().map((project) => project.name)).toEqual(['Vesper', '博客']);
  });

  test('one project per folder, whatever the case or trailing backslash', () => {
    store.create('a', 'D:\\Code');
    expect(() => store.create('b', 'd:\\code\\')).toThrow(expect.objectContaining({ code: 'duplicate' }));
  });

  test.each(['', '   ', 'x'.repeat(101), 'tab\there'])('refuses the name %j', (name) => {
    expect(() => store.create(name, 'D:\\x')).toThrow(ProjectError);
  });

  test('refuses a path that is not an absolute local path', () => {
    for (const path of ['relative', '\\\\server\\share', 'C:\\a\u{0}b']) expect(() => store.create('x', path)).toThrow(expect.objectContaining({ code: 'bad_path' }));
  });

  test('renames, reorders and removes', () => {
    const a = store.create('a', 'D:\\a');
    const b = store.create('b', 'D:\\b');
    const c = store.create('c', 'D:\\c');
    expect(store.rename(b.id, '乙')).toMatchObject({ id: b.id, name: '乙' });
    store.reorder([c.id, a.id, b.id]);
    expect(store.list().map((project) => project.name)).toEqual(['c', 'a', '乙']);
    expect(() => store.reorder([c.id, a.id])).toThrow(expect.objectContaining({ code: 'bad_order' }));
    expect(() => store.reorder([c.id, a.id, a.id])).toThrow(expect.objectContaining({ code: 'bad_order' }));
    store.remove(a.id);
    expect(store.list().map((project) => project.id)).toEqual([c.id, b.id]);
    expect(() => store.rename(a.id, 'gone')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => store.remove(a.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  test('finds the project a directory belongs to: the deepest folder that contains it', () => {
    const code = store.create('code', 'D:\\code');
    const vesper = store.create('vesper', 'D:\\code\\work_space\\vesper');
    const root = store.create('E drive', 'E:\\');
    expect(store.forDirectory('d:\\CODE\\work_space\\vesper\\packages')?.id).toBe(vesper.id);
    expect(store.forDirectory('D:\\code\\other')?.id).toBe(code.id);
    expect(store.forDirectory('D:\\code')?.id).toBe(code.id);
    expect(store.forDirectory('D:\\code2')).toBeUndefined();
    expect(store.forDirectory('E:\\anything')?.id).toBe(root.id);
    expect(store.forDirectory('C:\\Users')).toBeUndefined();
  });
});
