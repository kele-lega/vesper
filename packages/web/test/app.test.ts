import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect as connectTcp, createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { decodeFrame, encodeFrame, type ControlMessage, type Frame } from '@vesper/protocol';
import { createApp, parseTarget } from '../src/app.js';
import { AuthStore } from '../src/auth-store.js';
import { localOrigins, type WebConfig } from '../src/config.js';
import { hashPassword } from '../src/password.js';
import { HostSupervisor } from '../src/supervisor.js';
import { openWebDatabase } from '../src/web-db.js';

const SLOW = 60_000;
const PTYD_MAIN = fileURLToPath(new URL('../../ptyd/src/main.ts', import.meta.url));
const PASSWORD = 'correct horse battery';

interface Client {
  ws: WebSocket;
  frames: Frame[];
  closed: Promise<number>;
  text(): string;
  type(input: string): void;
}

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe.runIf(process.platform === 'win32')('vesper-web', () => {
  let home: string;
  let server: Server;
  let supervisor: HostSupervisor;
  let base: string;
  let config: WebConfig;
  let cookie = '';
  let cmdProfile = '';
  let db: DatabaseSync;

  const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: config.origins[0]!, 'x-vesper': '1', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(response: Promise<Response>, status = 200): Promise<T> => {
    const reply = await response;
    expect(reply.status).toBe(status);
    return (await reply.json()) as T;
  };
  const ticket = async () => (await json<{ ticket: string }>(api('POST', '/api/ws-ticket'))).ticket;
  const openTab = async (projectId: string | null = null) =>
    (await json<{ session: { id: string } }>(api('POST', '/api/tabs', { projectId, profileId: cmdProfile }), 201)).session.id;
  /** Like a page reconnecting: wait until the supervisor talks to a host other than `pid`. */
  const waitForNewHost = async (pid: number) => {
    const deadline = Date.now() + 40_000;
    for (;;) {
      const now = await supervisor.control().then((client) => client.ping()).then((pong) => pong.pid, () => pid);
      if (now !== pid) return;
      if (Date.now() > deadline) throw new Error('no new host');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const socket = (path: string, pass: string | undefined, origin = config.origins[0]) => {
    const protocols = ['vesper.v1', ...(pass === undefined ? [] : [`vesper.ticket.${pass}`])];
    return new WebSocket(`${base.replace('http', 'ws')}${path}`, protocols, { ...(origin ? { origin } : {}), perMessageDeflate: false });
  };
  const open = async (path: string, options: { pass?: string; origin?: string } = {}): Promise<Client> => {
    const ws = socket(path, 'pass' in options ? options.pass : await ticket(), options.origin);
    const frames: Frame[] = [];
    ws.on('message', (raw: Buffer) => frames.push(decodeFrame(raw)));
    ws.on('error', () => undefined);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const text = () =>
      frames.map((f) => (f.type === 'output' || f.type === 'snapshot' ? Buffer.from(f.data).toString('utf8') : '')).join('');
    const opened = new Promise((resolve) => ws.once('open', resolve));
    const type = (input: string) => void opened.then(() => ws.send(encodeFrame({ type: 'input', data: Buffer.from(input, 'utf8') })));
    return { ws, frames, closed, text, type };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'vesper-web-'));
    const uiDist = join(home, 'ui');
    mkdirSync(uiDist);
    writeFileSync(join(uiDist, 'index.html'), '<!doctype html><title>Vesper</title>');
    writeFileSync(join(uiDist, 'app.js'), 'console.log(1)');
    supervisor = new HostSupervisor({ home, ptydArgs: ['--import', 'tsx', PTYD_MAIN], heartbeatMs: 1000 });
    const port = await freePort();
    config = {
      home, port, bind: '127.0.0.1', origins: localOrigins(port), uiDist, database: join(home, 'web', 'vesper.db'), defaultCwd: tmpdir(),
      profileSources: { wtSettings: undefined, appData: home, gitBash: join(home, 'no-bash.exe') },
    };
    db = openWebDatabase(config.database);
    new AuthStore(db).setPasswordHash(await hashPassword(PASSWORD, { N: 1 << 10, r: 8, p: 1 }));
    server = createApp(config, supervisor, { db });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${port}`;
    await supervisor.start();
  }, SLOW);

  afterAll(async () => {
    await (await supervisor.control()).shutdown().catch(() => undefined);
    supervisor.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, SLOW);

  test('serves the UI and its security headers before login', async () => {
    const page = await fetch(`${base}/p/abc`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Vesper</title>');
    expect(page.headers.get('content-security-policy')).toContain(`connect-src 'self' ${base.replace('http', 'ws')}`);
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  test('logs in with the password, and the API needs the cookie and the write header', async () => {
    expect((await api('GET', '/api/state')).status).toBe(401);
    expect((await api('POST', '/api/login', { password: 'wrong password!' })).status).toBe(401);
    const login = await api('POST', '/api/login', { password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-vesper=[\w-]+; .*HttpOnly; Secure; SameSite=Strict/);
    cookie = setCookie.split(';')[0]!;
    const state = await json<{ profiles: { id: string; name: string }[]; hostOnline: boolean }>(api('GET', '/api/state'));
    cmdProfile = state.profiles.find((profile) => profile.name === '命令提示符')!.id;
    expect(state.profiles.map((profile) => profile.name)).toEqual(['Windows PowerShell', '命令提示符']);
    expect((await api('POST', '/api/projects', { name: 'x' }, { 'x-vesper': '' })).status).toBe(403);
    expect((await api('POST', '/api/projects', { name: 'x' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('GET', '/api/nothing')).status).toBe(404);
  });

  test('projects hold tabs that start in their folder, and the control socket follows along', async () => {
    const control = socket('/ws/control', await ticket());
    const messages: ControlMessage[] = [];
    control.on('message', (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as ControlMessage));
    await until(() => messages.some((message) => message.type === 'snapshot'));

    const folder = mkdtempSync(join(home, 'proj-'));
    const { project } = await json<{ project: { id: string } }>(api('POST', '/api/projects', { name: '演示', path: folder }), 201);
    const id = await openTab(project.id);
    const client = await open(`/ws/sessions/${id}?cols=100&rows=30`);
    client.type('cd\r');
    await until(() => client.text().includes(folder));
    await until(() => messages.some((message) => message.type === 'tabs' && message.tabs.some((tab) => tab.sessionId === id)));

    const listing = await json<{ folders: { path: string }[] }>(api('GET', `/api/folders?path=${encodeURIComponent(home)}`));
    expect(listing.folders.map((entry) => entry.path.toLowerCase())).toContain(folder.toLowerCase());

    expect((await api('DELETE', `/api/projects/${project.id}`)).status).toBe(200);
    expect(await client.closed).toBe(4000);
    const state = await json<{ projects: unknown[]; tabs: unknown[] }>(api('GET', '/api/state'));
    expect(state.projects).toEqual([]);
    control.close();
  }, SLOW);

  test('relays a tab over WebSocket and resumes without repeating output', async () => {
    const id = await openTab();
    const first = await open(`/ws/sessions/${id}?cols=100&rows=30`);
    await until(() => first.frames[0]?.type === 'snapshot');
    first.type('echo relayed-%OS%\r');
    await until(() => first.text().includes('relayed-Windows_NT'));
    const snapshot = first.frames[0] as Extract<Frame, { type: 'snapshot' }>;
    const outputs = first.frames.filter((frame): frame is Extract<Frame, { type: 'output' }> => frame.type === 'output');
    const end = outputs.reduce((seq, frame) => Math.max(seq, frame.seq + frame.data.length), snapshot.seq);
    first.ws.close();
    await first.closed;

    const again = await open(`/ws/sessions/${id}?inc=${snapshot.inc}&seq=${end}`);
    again.type('echo resumed-%OS%\r');
    await until(() => again.text().includes('resumed-Windows_NT'));
    expect(again.frames[0]?.type).toBe('size');
    expect(again.text()).not.toContain('relayed-Windows_NT');
    again.ws.close();
    expect((await api('DELETE', `/api/tabs/${id}`)).status).toBe(200);
  }, SLOW);

  test('refuses WebSockets without a fresh ticket, from other origins, or with bad frames', async () => {
    const id = await openTab();
    expect(await (await open(`/ws/sessions/${id}`, { pass: undefined })).closed).toBe(1006);
    expect(await (await open(`/ws/sessions/${id}`, { pass: 'made-up' })).closed).toBe(1006);
    expect(await (await open(`/ws/sessions/${id}`, { origin: 'https://evil.example' })).closed).toBe(1006);
    const used = await ticket();
    const first = await open(`/ws/sessions/${id}`, { pass: used });
    await until(() => first.frames.length > 0);
    first.ws.close();
    expect(await (await open(`/ws/sessions/${id}`, { pass: used })).closed).toBe(1006);
    expect(await (await open('/ws/sessions/unknown1')).closed).toBe(4004);
    const huge = await open(`/ws/sessions/${id}`);
    await new Promise((resolve) => huge.ws.once('open', resolve));
    huge.ws.send(encodeFrame({ type: 'input', data: new Uint8Array(2 << 20) }));
    expect(await huge.closed).toBe(1009);
    await api('DELETE', `/api/tabs/${id}`);
  }, SLOW);

  test('a host shutdown closes streams with 1012, and the next host brings the tab back', async () => {
    const id = await openTab();
    const client = await open(`/ws/sessions/${id}`);
    client.type('echo survives-%OS%\r');
    await until(() => client.text().includes('survives-Windows_NT'));
    const before = (await (await supervisor.control()).ping()).pid;
    await (await supervisor.control()).shutdown();
    expect(await client.closed).toBe(1012);
    await waitForNewHost(before);
    const after = await open(`/ws/sessions/${id}`);
    await until(() => after.text().includes('survives-Windows_NT') && after.text().includes('已恢复历史'), 40_000);
    after.ws.close();
  }, SLOW);

  test('answers only to its own Host names', async () => {
    const port = Number(new URL(base).port);
    const request = (host: string, path: string) => rawStatus(port, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    expect(await request(`localhost:${port}`, '/')).toBe('HTTP/1.1 200 OK');
    // A page on a domain re-pointed at 127.0.0.1 (DNS rebinding) arrives with its own Host.
    expect(await request(`rebind.example:${port}`, '/')).toMatch(/^HTTP\/1\.1 421/);
  });

  test('logging out ends the device, its cookie and its sockets', async () => {
    const id = await openTab();
    const client = await open(`/ws/sessions/${id}`);
    await until(() => client.frames.length > 0);
    expect((await api('POST', '/api/logout')).status).toBe(200);
    expect(await client.closed).toBe(1008);
    expect((await api('GET', '/api/state')).status).toBe(401);
  }, SLOW);
});

/** Sends a raw HTTP request (fetch cannot set Host) and resolves with the status line. */
function rawStatus(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

describe('parseTarget', () => {
  test.each([
    ['/ws/sessions/abc', { session: 'abc' }],
    ['/ws/sessions/abc?inc=2&seq=10', { session: 'abc', resume: { inc: 2, seq: 10 } }],
    ['/ws/sessions/abc?cols=80&rows=24', { session: 'abc', size: { cols: 80, rows: 24 } }],
    ['/ws/sessions/abc?seq=-1&inc=1&cols=0&rows=5', { session: 'abc' }],
  ])('%s', (url, expected) => {
    expect(parseTarget(url)).toEqual(expected);
  });

  test.each(['/ws/sessions/', '/ws/sessions/a.b', '/ws/other/abc'])('rejects %s', (url) => {
    expect(parseTarget(url)).toBeUndefined();
  });
});
