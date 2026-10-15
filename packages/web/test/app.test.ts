import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect as connectTcp, createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { createApp, parseTarget } from '../src/app.js';
import { localOrigins, type WebConfig } from '../src/config.js';
import { HostSupervisor } from '../src/supervisor.js';

const SLOW = 60_000;
const PTYD_MAIN = fileURLToPath(new URL('../../ptyd/src/main.ts', import.meta.url));
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';

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

  const api = (method: string, path: string, body?: unknown, token = TOKEN) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
  const createSession = async (shell = 'cmd') => {
    const response = await api('POST', '/api/sessions', { shell, cwd: tmpdir() });
    expect(response.status).toBe(201);
    return ((await response.json()) as { session: { id: string } }).session.id;
  };
  const open = (path: string, { token = TOKEN, origin = config.origins[0] } = {}): Client => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, ['vesper.v1', `vesper.token.${token}`], {
      ...(origin ? { origin } : {}),
      perMessageDeflate: false,
    });
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
    config = { home, port, bind: '127.0.0.1', origins: localOrigins(port), uiDist, token: TOKEN, defaultCwd: tmpdir() };
    server = createApp(config, supervisor);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${port}`;
    await supervisor.start();
  }, SLOW);

  afterAll(async () => {
    await (await supervisor.control()).shutdown().catch(() => undefined);
    supervisor.stop();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, SLOW);

  test('serves the UI, its page routes and security headers without a token', async () => {
    const page = await fetch(`${base}/s/abc`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Vesper</title>');
    expect(page.headers.get('content-security-policy')).toContain(`connect-src 'self' ${base.replace('http', 'ws')}`);
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
  });

  test('the API needs the token', async () => {
    expect((await api('GET', '/api/sessions', undefined, 'wrong')).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    const config = (await (await api('GET', '/api/config')).json()) as { shells: string[] };
    expect(config.shells).toEqual(['powershell', 'cmd', 'gitbash']);
  });

  test('creates, lists, reads and deletes sessions, and rejects bad input', async () => {
    const id = await createSession();
    const { sessions } = (await (await api('GET', '/api/sessions')).json()) as { sessions: { id: string }[] };
    expect(sessions.map((session) => session.id)).toContain(id);
    expect((await api('GET', `/api/sessions/${id}`)).status).toBe(200);
    expect((await api('POST', '/api/sessions', { shell: 'bash' })).status).toBe(400);
    expect((await api('POST', '/api/sessions', { shell: 'cmd', cwd: 'Z:\\nowhere' })).status).toBe(400);
    expect((await api('PUT', '/api/sessions')).status).toBe(405);
    expect((await api('GET', '/api/sessions/bad.id')).status).toBe(400);
    expect((await api('GET', '/api/nothing')).status).toBe(404);
    expect((await api('DELETE', `/api/sessions/${id}`)).status).toBe(200);
    expect((await api('GET', `/api/sessions/${id}`)).status).toBe(404);
    expect((await api('DELETE', `/api/sessions/${id}`)).status).toBe(404);
  }, SLOW);

  test('relays a session over WebSocket and resumes without repeating output', async () => {
    const id = await createSession();
    const first = open(`/ws/sessions/${id}?cols=100&rows=30`);
    await until(() => first.frames[0]?.type === 'snapshot');
    first.type('echo relayed-%OS%\r');
    await until(() => first.text().includes('relayed-Windows_NT'));
    first.ws.send(encodeFrame({ type: 'ping', nonce: 7 })); // open by now: output arrived
    await until(() => first.frames.some((frame) => frame.type === 'pong' && frame.nonce === 7));
    const snapshot = first.frames[0] as Extract<Frame, { type: 'snapshot' }>;
    const outputs = first.frames.filter((frame): frame is Extract<Frame, { type: 'output' }> => frame.type === 'output');
    const end = outputs.reduce((seq, frame) => Math.max(seq, frame.seq + frame.data.length), snapshot.seq);
    first.ws.close();
    await first.closed;

    const again = open(`/ws/sessions/${id}?inc=${snapshot.inc}&seq=${end}`);
    again.type('echo resumed-%OS%\r');
    await until(() => again.text().includes('resumed-Windows_NT'));
    expect(again.frames[0]?.type).toBe('size');
    expect(again.text()).not.toContain('relayed-Windows_NT');
    again.ws.close();
  }, SLOW);

  test('closes with 4000 when the session is deleted and 4004 for unknown sessions', async () => {
    const id = await createSession();
    const client = open(`/ws/sessions/${id}`);
    await until(() => client.frames.length > 0);
    await api('DELETE', `/api/sessions/${id}`);
    expect(await client.closed).toBe(4000);
    expect(await open('/ws/sessions/unknown1').closed).toBe(4004);
  }, SLOW);

  test('refuses WebSockets without the token, from other origins, or with bad frames', async () => {
    const id = await createSession();
    expect(await open(`/ws/sessions/${id}`, { origin: 'https://evil.example' }).closed).toBe(1006);
    expect(await open(`/ws/sessions/${id}`, { origin: '' }).closed).toBe(1006);
    expect(await open(`/ws/sessions/${id}`, { token: 'wrong' }).closed).toBe(1006);
    expect(await open('/ws/sessions/bad.id').closed).toBe(1006);
    const text = open(`/ws/sessions/${id}`);
    await new Promise((resolve) => text.ws.once('open', resolve));
    text.ws.send('not binary');
    expect(await text.closed).toBe(1008);
    const huge = open(`/ws/sessions/${id}`);
    await new Promise((resolve) => huge.ws.once('open', resolve));
    huge.ws.send(encodeFrame({ type: 'input', data: new Uint8Array(2 << 20) }));
    expect(await huge.closed).toBe(1009);
    await api('DELETE', `/api/sessions/${id}`);
  }, SLOW);

  test('a host shutdown closes streams with 1012, and the next host brings the session back', async () => {
    const id = await createSession();
    const client = open(`/ws/sessions/${id}`);
    client.type('echo survives-%OS%\r');
    await until(() => client.text().includes('survives-Windows_NT'));
    const before = (await (await supervisor.control()).ping()).pid;
    await (await supervisor.control()).shutdown();
    expect(await client.closed).toBe(1012);
    await waitForNewHost(before);
    const after = open(`/ws/sessions/${id}`);
    await until(() => after.text().includes('survives-Windows_NT') && after.text().includes('已恢复历史'), 40_000);
    const session = (await (await api('GET', `/api/sessions/${id}`)).json()) as { session: { inc: number } };
    expect(session.session.inc).toBe(2);
    after.ws.close();
  }, SLOW);

  test('answers only to its own Host names, and isolates its pages from other origins', async () => {
    const port = new URL(base).port;
    const request = (host: string, path: string, extra = '') =>
      rawStatus(Number(port), `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${extra}\r\n`);
    expect(await request(`127.0.0.1:${port}`, '/')).toBe('HTTP/1.1 200 OK');
    expect(await request(`localhost:${port}`, '/')).toBe('HTTP/1.1 200 OK');
    // A page on a domain re-pointed at 127.0.0.1 (DNS rebinding) arrives with its own Host.
    expect(await request(`rebind.example:${port}`, '/')).toMatch(/^HTTP\/1\.1 421/);
    const upgrade = `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${base}\r\nSec-WebSocket-Protocol: vesper.v1, vesper.token.${TOKEN}\r\n`;
    expect(await request(`rebind.example:${port}`, '/ws/sessions/abc', upgrade)).toMatch(/^HTTP\/1\.1 421/);
    const page = await fetch(`${base}/`);
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(page.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  test('counts wrong tokens without ever locking out the right one', async () => {
    for (let i = 0; i < 12; i++) await api('GET', '/api/sessions', undefined, 'wrong');
    expect((await api('GET', '/api/sessions', undefined, 'wrong')).status).toBe(429);
    // Every request through the reverse proxy shares one address; the owner must still get in.
    expect((await api('GET', '/api/sessions')).status).toBe(200);
  });
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
    ['/ws/sessions/abc?inc=2', { session: 'abc' }],
    ['/ws/sessions/abc?seq=-1&inc=1&cols=0&rows=5', { session: 'abc' }],
  ])('%s', (url, expected) => {
    expect(parseTarget(url)).toEqual(expected);
  });

  test.each(['/ws/sessions/', '/ws/sessions/a.b', '/ws/other/abc', '//'])('rejects %s', (url) => {
    expect(parseTarget(url)).toBeUndefined();
  });
});
