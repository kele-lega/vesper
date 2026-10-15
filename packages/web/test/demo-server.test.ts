import { spawn, type ChildProcess } from 'node:child_process';
import { connect as connectTcp } from 'node:net';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

const SLOW = 30_000;
const PORT = 17_690 + Math.floor(Math.random() * 1000);
const entry = fileURLToPath(new URL('../dist/demo-server.js', import.meta.url));

interface Server {
  child: ChildProcess;
  token: string;
  port: number;
}

function startServer(port: number): Promise<Server> {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, VESPER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const token = /token=(\S+)/.exec(out)?.[1];
      if (token) resolve({ child, token, port });
    });
    child.once('exit', (code) => reject(new Error(`demo server exited early with ${code}`)));
  });
}

interface Client {
  ws: WebSocket;
  frames: Frame[];
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpExecArray>;
}

async function connect(server: Server, token: string, params: Record<string, string>, origin: string | null = `http://127.0.0.1:${server.port}`): Promise<Client> {
  const query = new URLSearchParams({ token, ...params });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${query}`, { ...(origin ? { origin } : {}), perMessageDeflate: false });
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let output = '';
  ws.on('message', (raw: Buffer) => {
    const frame = decodeFrame(raw);
    frames.push(frame);
    if (frame.type === 'output') output += decoder.decode(frame.data, { stream: true });
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  ws.send(encodeFrame({ type: 'resize', cols: 120, rows: 30 }));
  const text = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  const waitFor = async (pattern: RegExp, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(text());
      if (match) return match;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { ws, frames, waitFor };
}

/** Sends a raw HTTP request and resolves with the status line, or '' if the socket just closes. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(process.platform === 'win32')('M0 demo server', () => {
  let server: Server;
  const alive = async () => (await fetch(`http://127.0.0.1:${server.port}/`)).status === 200 && server.child.exitCode === null;
  beforeAll(async () => {
    server = await startServer(PORT);
  }, SLOW);
  afterAll(() => {
    server?.child.kill();
  });

  test('rejects a wrong token', async () => {
    await expect(connect(server, 'wrong', {})).rejects.toThrow(/403/);
  });

  test('rejects a foreign origin even with the right token', async () => {
    await expect(connect(server, server.token, {}, 'https://evil.example')).rejects.toThrow(/403/);
  });

  test('rejects a missing origin', async () => {
    await expect(connect(server, server.token, {}, null)).rejects.toThrow(/403/);
  });

  test('survives malformed upgrade requests', async () => {
    const upgrade = (path: string) =>
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
    expect(await rawRequest(server.port, upgrade('//'))).toMatch(/^HTTP\/1\.1 400/);
    expect(await rawRequest(server.port, upgrade('/ws?token=%E0%A4%A'))).toMatch(/^HTTP\/1\.1 4\d\d/);
    expect(await alive()).toBe(true);
  });

  test('answers 400 to a malformed path and blocks traversal', async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/%E0%A4%A`)).status).toBe(400);
    expect(await rawRequest(server.port, 'GET /..%2f..%2fpackage.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 40[34]/);
    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await alive()).toBe(true);
  });

  test('closes a connection that sends an oversized frame and keeps running', async () => {
    const client = await connect(server, server.token, { session: 'big', shell: 'cmd' });
    const closed = new Promise<number>((resolve) => client.ws.once('close', resolve));
    client.ws.send(encodeFrame({ type: 'input', data: new Uint8Array(2 << 20) }));
    expect(await closed).toBe(1009);
    expect(await alive()).toBe(true);
  }, SLOW);

  test('sends a snapshot first, then echoes typed input with contiguous offsets', async () => {
    const client = await connect(server, server.token, { session: 'echo', shell: 'cmd' });
    await client.waitFor(/>/);
    // ConPTY positions lines with cursor moves rather than newlines, so match text only the
    // output can contain: cmd expands %OS% in the result, not in the echoed command line.
    client.ws.send(encodeFrame({ type: 'input', data: Buffer.from('echo vesper-%OS%\r') }));
    await client.waitFor(/vesper-Windows_NT/);
    const [snapshot, ...rest] = client.frames;
    expect(snapshot?.type).toBe('snapshot');
    let expected = snapshot?.type === 'snapshot' ? snapshot.seq : -1;
    for (const frame of rest.filter((f) => f.type === 'output')) {
      expect(frame.seq).toBe(expected);
      expected += frame.data.length;
    }
    client.ws.close();
  }, SLOW);

  test('a reconnecting client sees the earlier screen in its snapshot', async () => {
    const first = await connect(server, server.token, { session: 'persist', shell: 'cmd' });
    await first.waitFor(/>/);
    first.ws.send(encodeFrame({ type: 'input', data: Buffer.from('echo before-%OS%\r') }));
    await first.waitFor(/before-Windows_NT/);
    first.ws.close();

    const second = await connect(server, server.token, { session: 'persist', shell: 'cmd' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snapshot = second.frames.find((frame) => frame.type === 'snapshot');
    expect(snapshot && new TextDecoder().decode(snapshot.data)).toContain('before-Windows_NT');
    second.ws.close();
  }, SLOW);

  test('stopping the server ends the shells it started', async () => {
    // A dedicated server, so the other tests keep theirs.
    const own = await startServer(PORT + 1);
    const client = await connect(own, own.token, { session: 'job', shell: 'powershell' });
    client.ws.send(encodeFrame({ type: 'input', data: Buffer.from('"pid=" + $PID\r') }));
    const pid = Number((await client.waitFor(/pid=(\d+)/, 20_000))[1]);
    expect(isAlive(pid)).toBe(true);

    const exited = new Promise((resolve) => own.child.once('exit', resolve));
    own.child.kill();
    await exited;
    const deadline = Date.now() + 5000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(pid)).toBe(false);
  }, SLOW);
});
