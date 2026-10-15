import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

const SLOW = 30_000;
const PORT = 17_690 + Math.floor(Math.random() * 1000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const entry = fileURLToPath(new URL('../dist/demo-server.js', import.meta.url));

function startServer(): Promise<{ child: ChildProcess; token: string }> {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, VESPER_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const token = /token=(\S+)/.exec(out)?.[1];
      if (token) resolve({ child, token });
    });
    child.once('exit', (code) => reject(new Error(`demo server exited early with ${code}`)));
  });
}

interface Client {
  ws: WebSocket;
  frames: Frame[];
  text: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpExecArray>;
}

async function connect(token: string, params: Record<string, string>, origin = ORIGIN): Promise<Client> {
  const query = new URLSearchParams({ token, ...params });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`, { origin, perMessageDeflate: false });
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
  return { ws, frames, text, waitFor };
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
  let server: { child: ChildProcess; token: string };
  beforeAll(async () => {
    server = await startServer();
  }, SLOW);
  afterAll(() => {
    server?.child.kill();
  });

  test('rejects a wrong token', async () => {
    await expect(connect('wrong', {})).rejects.toThrow(/403/);
  });

  test('rejects a foreign origin even with the right token', async () => {
    await expect(connect(server.token, {}, 'https://evil.example')).rejects.toThrow(/403/);
  });

  test('sends a snapshot first, then echoes typed input', async () => {
    const client = await connect(server.token, { session: 'echo', shell: 'cmd' });
    await client.waitFor(/>/);
    expect(client.frames[0]?.type).toBe('snapshot');
    // ConPTY positions lines with cursor moves rather than newlines, so match text only the
    // output can contain: cmd expands %OS% in the result, not in the echoed command line.
    client.ws.send(encodeFrame({ type: 'input', data: Buffer.from('echo vesper-%OS%\r') }));
    await client.waitFor(/vesper-Windows_NT/);
    client.ws.close();
  }, SLOW);

  test('a reconnecting client sees the earlier screen in its snapshot', async () => {
    const first = await connect(server.token, { session: 'persist', shell: 'cmd' });
    await first.waitFor(/>/);
    first.ws.send(encodeFrame({ type: 'input', data: Buffer.from('echo before-%OS%\r') }));
    await first.waitFor(/before-Windows_NT/);
    first.ws.close();

    const second = await connect(server.token, { session: 'persist', shell: 'cmd' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snapshot = second.frames.find((frame) => frame.type === 'snapshot');
    expect(snapshot && new TextDecoder().decode(snapshot.data)).toContain('before-Windows_NT');
    second.ws.close();
  }, SLOW);

  test('stopping the server ends the shells it started', async () => {
    const client = await connect(server.token, { session: 'job', shell: 'powershell' });
    client.ws.send(encodeFrame({ type: 'input', data: Buffer.from('"pid=" + $PID\r') }));
    const pid = Number((await client.waitFor(/pid=(\d+)/, 20_000))[1]);
    expect(isAlive(pid)).toBe(true);

    const exited = new Promise((resolve) => server.child.once('exit', resolve));
    server.child.kill();
    await exited;
    const deadline = Date.now() + 5000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(pid)).toBe(false);
  }, SLOW);
});
