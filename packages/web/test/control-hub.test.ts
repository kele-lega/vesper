import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ControlMessage, HostEvent, SessionInfo } from '@vesper/protocol';
import type { ControlClient } from '@vesper/ptyd/client';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ControlHub, DeviceSockets } from '../src/control-hub.js';
import { ProfileStore } from '../src/profile-store.js';
import { ProjectStore } from '../src/project-store.js';
import { TabStore } from '../src/tab-store.js';
import { openWebDatabase } from '../src/web-db.js';

const session = (id: string, cwd = 'D:\\one', overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id, shell: 'cmd', title: id, cwd, status: 'running', exitCode: null, inc: 1, cols: 120, rows: 30, createdAt: 1, attached: 0, ...overrides,
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: ControlMessage[] = [];
  closedWith: number | undefined;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ControlMessage);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
    this.emit('close');
  }
  terminate(): void {
    this.close(1006);
  }
}

function fakeClient(sessions: SessionInfo[]) {
  const events = new Set<(event: HostEvent) => void>();
  const closes = new Set<() => void>();
  const client = {
    onEvent: (listener: (event: HostEvent) => void) => (events.add(listener), () => events.delete(listener)),
    onClose: (listener: () => void) => (closes.add(listener), () => closes.delete(listener)),
    list: async () => sessions,
  } as unknown as ControlClient;
  return { client, emit: (event: HostEvent) => events.forEach((listener) => listener(event)), close: () => closes.forEach((listener) => listener()) };
}

describe('ControlHub', () => {
  let dir: string;
  let db: DatabaseSync;
  let hub: ControlHub;
  let projects: ProjectStore;
  let tabs: TabStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-hub-'));
    db = openWebDatabase(join(dir, 'vesper.db'));
    projects = new ProjectStore(db);
    tabs = new TabStore(db);
    const profiles = new ProfileStore(db);
    profiles.seed(() => [{ name: 'cmd', launch: { command: { commandLine: 'x', env: { SECRET: 'k' } } }, agent: null, elevation: 'normal', source: 'wt', wtGuid: null }]);
    hub = new ControlHub({ projects, tabs, profiles });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = () => {
    const ws = new FakeSocket();
    hub.accept(ws as unknown as WebSocket);
    return ws;
  };

  test('a page gets a snapshot; profiles never carry their command or environment', async () => {
    const one = projects.create('one', 'D:\\one');
    await hub.adopt(fakeClient([session('a'), session('b', 'C:\\elsewhere')]).client);
    const page = connect();
    const snapshot = page.sent[0];
    expect(snapshot).toMatchObject({ type: 'snapshot', hostOnline: true, projects: [{ id: one.id }], sessions: [{ id: 'a' }, { id: 'b' }] });
    expect(snapshot && 'tabs' in snapshot && snapshot.tabs.map((tab) => [tab.sessionId, tab.projectId])).toEqual([['a', one.id], ['b', null]]);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
    expect(snapshot && 'profiles' in snapshot && snapshot.profiles[0]).toEqual({ id: expect.any(String), name: 'cmd', shell: null, agent: null, elevation: 'normal' });
  });

  test('forwards session changes, removals and notices, and tells pages when the host goes away', async () => {
    const host = fakeClient([session('a')]);
    await hub.adopt(host.client);
    const page = connect();
    host.emit({ event: 'session', session: session('a', 'D:\\one', { status: 'exited' }) });
    host.emit({ event: 'notice', session: 'a', title: '', body: 'done', at: 5 });
    host.emit({ event: 'removed', session: 'a' });
    host.close();
    expect(page.sent.slice(1).map((message) => message.type)).toEqual(['session', 'notice', 'removed', 'tabs', 'host']);
    expect(page.sent.at(-1)).toEqual({ type: 'host', online: false });
    expect(tabs.list()).toEqual([]);
  });

  test('stops sending to a closed page and drops a page that does not read', async () => {
    await hub.adopt(fakeClient([]).client);
    const gone = connect();
    const slow = connect();
    gone.close();
    slow.bufferedAmount = 64 << 20;
    hub.tabsChanged();
    expect(gone.sent).toHaveLength(1);
    expect(slow.closedWith).toBe(1006);
  });
});

describe('DeviceSockets', () => {
  test('closes the sockets of a device that logged out, or is no longer logged in', () => {
    const registry = new DeviceSockets();
    const [a1, a2, b] = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    registry.track(a1 as unknown as WebSocket, 'a');
    registry.track(a2 as unknown as WebSocket, 'a');
    registry.track(b as unknown as WebSocket, 'b');
    registry.closeDevice('a');
    expect([a1.closedWith, a2.closedWith, b.closedWith]).toEqual([1008, 1008, undefined]);
    registry.closeUnless((device) => device !== 'b');
    expect(b.closedWith).toBe(1008);
    expect(registry.size).toBe(0);
  });
});
