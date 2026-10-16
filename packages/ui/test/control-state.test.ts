import type { ControlState, SessionInfo, TabInfo } from '@vesper/protocol';
import { describe, expect, test } from 'vitest';
import { applyControl, projectCounts, tabsOf, tabTitle } from '../src/app/control-state.js';

const session = (id: string, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id, shell: 'cmd', title: `title ${id}`, cwd: 'D:\\x', status: 'running', exitCode: null, inc: 1, cols: 120, rows: 30, createdAt: 1, attached: 0, ...overrides,
});
const tab = (sessionId: string, projectId: string | null, position: number, name = ''): TabInfo => ({ sessionId, projectId, profileId: null, name, position });

const base: ControlState = {
  projects: [{ id: 'p1', name: 'one', path: 'D:\\one', position: 0, createdAt: 1 }],
  tabs: [tab('b', 'p1', 1), tab('a', 'p1', 0, '构建'), tab('u', null, 0), tab('ghost', 'p1', 2)],
  sessions: [session('a'), session('b', { status: 'exited', exitCode: 0 }), session('u')],
  profiles: [],
  hostOnline: true,
};

describe('applyControl', () => {
  test('starts from a snapshot and ignores changes before one', () => {
    expect(applyControl(undefined, { type: 'host', online: false })).toBeUndefined();
    expect(applyControl(undefined, { type: 'snapshot', ...base })).toEqual(base);
  });

  test('updates a session in place, adds new ones and drops removed ones', () => {
    const renamed = applyControl(base, { type: 'session', session: session('a', { title: 'new' }) })!;
    expect(renamed.sessions.map((s) => [s.id, s.title])).toEqual([['a', 'new'], ['b', 'title b'], ['u', 'title u']]);
    const added = applyControl(renamed, { type: 'session', session: session('c') })!;
    expect(added.sessions.map((s) => s.id)).toEqual(['a', 'b', 'u', 'c']);
    expect(applyControl(added, { type: 'removed', session: 'b' })!.sessions.map((s) => s.id)).toEqual(['a', 'u', 'c']);
    expect(base.sessions).toHaveLength(3);
  });

  test('replaces whole lists and tracks the host', () => {
    expect(applyControl(base, { type: 'tabs', tabs: [] })!.tabs).toEqual([]);
    expect(applyControl(base, { type: 'projects', projects: [] })!.projects).toEqual([]);
    expect(applyControl(base, { type: 'host', online: false })!.hostOnline).toBe(false);
    expect(applyControl(base, { type: 'notice', notice: { session: 'a', title: '', body: 'x', at: 1 } })).toBe(base);
  });
});

describe('selectors', () => {
  test('tabsOf lists a project’s tabs in order, skipping tabs whose session is unknown', () => {
    expect(tabsOf(base, 'p1').map(({ tab, session }) => [tab.sessionId, session.id])).toEqual([['a', 'a'], ['b', 'b']]);
    expect(tabsOf(base, null).map(({ tab }) => tab.sessionId)).toEqual(['u']);
  });

  test('a tab shows its own name, else the session title', () => {
    const [named, unnamed] = tabsOf(base, 'p1');
    expect(tabTitle(named!.tab, named!.session)).toBe('构建');
    expect(tabTitle(unnamed!.tab, unnamed!.session)).toBe('title b');
  });

  test('projectCounts counts sessions and running ones per project, with unsorted under null', () => {
    expect(projectCounts(base)).toEqual(new Map([['p1', { sessions: 2, running: 1 }], [null, { sessions: 1, running: 1 }]]));
  });
});
