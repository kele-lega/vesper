import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ProfileStore } from '../src/profile-store.js';
import { ProjectStore } from '../src/project-store.js';
import { TabError, TabStore } from '../src/tab-store.js';
import { openWebDatabase } from '../src/web-db.js';

describe('TabStore', () => {
  let dir: string;
  let db: DatabaseSync;
  let tabs: TabStore;
  let projects: ProjectStore;
  let p1: string;
  let p2: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-tabs-'));
    db = openWebDatabase(join(dir, 'vesper.db'));
    tabs = new TabStore(db, () => 5000);
    projects = new ProjectStore(db, Date.now, 'win32');
    p1 = projects.create('one', 'D:\\one').id;
    p2 = projects.create('two', 'D:\\two').id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const order = (projectId: string | null) => tabs.list().filter((tab) => tab.projectId === projectId).map((tab) => tab.sessionId);

  test('adds tabs at the end of their own project', () => {
    expect(tabs.add('s1', p1, null)).toEqual({ sessionId: 's1', projectId: p1, profileId: null, name: '', position: 0, createdAt: 5000, worktree: null, branch: null });
    tabs.add('s2', p2, null);
    tabs.add('s3', p1, null);
    tabs.add('s4', null, null);
    expect(order(p1)).toEqual(['s1', 's3']);
    expect(tabs.list().find((tab) => tab.sessionId === 's3')?.position).toBe(1);
    expect(order(null)).toEqual(['s4']);
  });

  test('renames a tab, and an empty name goes back to the session title', () => {
    tabs.add('s1', p1, null);
    expect(tabs.rename('s1', ' 构建 ').name).toBe('构建');
    expect(tabs.rename('s1', '').name).toBe('');
    expect(() => tabs.rename('s1', 'x'.repeat(101))).toThrow(TabError);
    expect(() => tabs.rename('nope', 'x')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  test('reorders the tabs of one project, including the unsorted ones', () => {
    for (const id of ['a', 'b', 'c']) tabs.add(id, p1, null);
    tabs.add('x', null, null);
    tabs.add('y', null, null);
    tabs.reorder(p1, ['c', 'a', 'b']);
    tabs.reorder(null, ['y', 'x']);
    expect(order(p1)).toEqual(['c', 'a', 'b']);
    expect(order(null)).toEqual(['y', 'x']);
    expect(() => tabs.reorder(p1, ['c', 'a', 'x'])).toThrow(expect.objectContaining({ code: 'bad_order' }));
  });

  test('sync adopts sessions it has never seen by their directory, and drops tabs of sessions that are gone', () => {
    tabs.add('kept', p2, null);
    tabs.add('gone', p1, null);
    tabs.sync(
      [
        { id: 'kept', cwd: 'D:\\one' },
        { id: 'old-m1', cwd: 'D:\\one\\src' },
        { id: 'elsewhere', cwd: 'C:\\Users' },
      ],
      (cwd) => projects.forDirectory(cwd)?.id,
    );
    expect(order(p1)).toEqual(['old-m1']);
    expect(order(p2)).toEqual(['kept']);
    expect(order(null)).toEqual(['elsewhere']);
  });

  test('place puts a session where it was created, whether or not a sync adopted it first', () => {
    const profiles = new ProfileStore(db, Date.now, 'win32');
    const shell = { launch: { shell: 'cmd' as const }, agent: null, elevation: 'admin' as const, source: 'builtin' as const, wtGuid: null };
    profiles.seed(() => [{ name: 'a', ...shell }, { name: 'b', ...shell }]);
    const [a, b] = profiles.list().map((profile) => profile.id);
    tabs.add('first', p1, null);
    expect(tabs.place('new', p1, a!)).toMatchObject({ sessionId: 'new', projectId: p1, profileId: a, position: 1 });
    tabs.add('adopted', null, null);
    expect(tabs.place('adopted', p2, b!)).toMatchObject({ projectId: p2, profileId: b, position: 0 });
    expect(order(null)).toEqual([]);
  });

  test('removing a project removes its tabs', () => {
    tabs.add('s1', p1, null);
    tabs.add('s2', p2, null);
    projects.remove(p1);
    expect(tabs.list().map((tab) => tab.sessionId)).toEqual(['s2']);
  });
});
