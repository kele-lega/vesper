import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  decodeJson,
  encodeFrame,
  encodeJson,
  encodePipeMessage,
  HOST_PROTOCOL_VERSION as V,
  PipeReader,
  type Frame,
  type HostEvent,
} from '@vesper/protocol';
import { AttachChannel, ControlClient } from '../src/client.js';
import { checkProof, newNonce, proof } from '../src/handshake.js';
import { Host } from '../src/host.js';
import { startPipeServer, type PipeServer } from '../src/server.js';

const SLOW = 30_000;
const TOKEN = 'server-test-token';
const shellPaths = { systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' };

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A raw pipe connection: send JSON or bytes, read the replies, see when the host hangs up. */
function rawConnection(pipe: string) {
  const replies: unknown[] = [];
  const socket = connect(pipe);
  const reader = new PipeReader((message) => replies.push(decodeJson(message)));
  socket.on('data', (chunk) => reader.push(chunk));
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  return {
    replies,
    closed,
    send: (value: unknown) => socket.write(encodePipeMessage(value instanceof Uint8Array ? value : encodeJson(value))),
    close: () => socket.destroy(),
  };
}

describe.runIf(process.platform === 'win32')('pipe server', () => {
  let dir: string;
  let host: Host;
  let server: PipeServer;
  let pipe: string;
  let shutdowns: number;
  const opened: { close(): void }[] = [];
  const address = () => ({ pipe, token: TOKEN });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-server-'));
    host = new Host({ dataDir: dir, shellPaths, timing: { flushMs: 50, checkpointMs: 200, metaMs: 20 } });
    pipe = `\\\\.\\pipe\\vesper-test-${randomBytes(6).toString('hex')}`;
    shutdowns = 0;
    server = await startPipeServer({ pipe, token: TOKEN, host, onShutdown: () => shutdowns++, startedAt: Date.now() });
  });

  afterEach(async () => {
    for (const connection of opened.splice(0)) connection.close();
    await server.close();
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('answers control requests and reports session events', async () => {
    const client = await ControlClient.connect(address());
    opened.push(client);
    const events: HostEvent[] = [];
    client.onEvent((event) => events.push(event));
    expect((await client.ping()).pid).toBe(process.pid);
    const session = await client.create({ shell: 'cmd', cwd: tmpdir() });
    expect(await client.list()).toEqual([expect.objectContaining({ id: session.id, status: 'running' })]);
    await client.kill(session.id);
    await waitFor(() => events.some((event) => event.event === 'session' && event.session.status === 'exited'));
    await client.remove(session.id);
    expect(await client.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ event: 'removed', session: session.id });
    await client.shutdown();
    expect(shutdowns).toBe(1);
  }, SLOW);

  test('turns host errors into error replies', async () => {
    const client = await ControlClient.connect(address());
    opened.push(client);
    await expect(client.kill('missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.create({ shell: 'cmd', cwd: 'relative\\dir' })).rejects.toMatchObject({ code: 'bad_cwd' });
  });

  /** Runs the handshake by hand as a client holding `token`; resolves with the host's final reply. */
  const handshake = async (raw: ReturnType<typeof rawConnection>, token = TOKEN) => {
    const clientNonce = newNonce();
    raw.send({ v: V, nonce: clientNonce, role: 'control' });
    await waitFor(() => raw.replies.length >= 1);
    const challenge = raw.replies[0] as { proof: string; nonce: string };
    expect(checkProof(TOKEN, 'host', clientNonce, challenge.proof)).toBe(true);
    raw.send({ proof: proof(token, 'client', challenge.nonce) });
    await waitFor(() => raw.replies.length >= 2);
    return raw.replies[1];
  };

  test('answers a malformed request that has an id, and hangs up on one that has none', async () => {
    const raw = rawConnection(pipe);
    opened.push(raw);
    expect(await handshake(raw)).toMatchObject({ ok: true, v: V });
    raw.send({ id: 5, op: 'nope' });
    await waitFor(() => raw.replies.length === 3);
    expect(raw.replies[2]).toMatchObject({ id: 5, ok: false, error: 'bad_request' });
    raw.send({ op: 'list' });
    await raw.closed;
  });

  test('a client whose proof is wrong is refused and dropped', async () => {
    const raw = rawConnection(pipe);
    opened.push(raw);
    expect(await handshake(raw, 'a-different-token')).toMatchObject({ ok: false, error: 'unauthorized' });
    await raw.closed;
  });

  test('a client does not trust a pipe that cannot prove it holds the token', async () => {
    const impostorPipe = `\\\\.\\pipe\\vesper-test-${randomBytes(6).toString('hex')}`;
    const proofsReceived: unknown[] = [];
    const impostor = createNetServer((socket) => {
      const reader = new PipeReader((message) => {
        const value = decodeJson(message) as { nonce?: string; proof?: string };
        if (value.proof !== undefined) proofsReceived.push(value);
        else socket.write(encodePipeMessage(encodeJson({ proof: proof('guessed-token', 'host', value.nonce!), nonce: newNonce() })));
      });
      socket.on('data', (chunk) => reader.push(chunk));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => impostor.listen(impostorPipe, resolve));
    try {
      await expect(ControlClient.connect({ pipe: impostorPipe, token: TOKEN })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(proofsReceived).toEqual([]);
    } finally {
      await new Promise((resolve) => impostor.close(resolve));
    }
  });

  test('refuses bad tokens, other versions, garbage, unknown sessions and oversized hellos', async () => {
    await expect(ControlClient.connect({ pipe, token: 'wrong' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(AttachChannel.open(address(), { session: 'missing' })).rejects.toMatchObject({ code: 'not_found' });
    for (const [hello, error] of [
      [{ v: V + 1, nonce: newNonce(), role: 'control' }, 'version_mismatch'],
      [Uint8Array.of(0xff), 'bad_request'],
    ] as const) {
      const raw = rawConnection(pipe);
      opened.push(raw);
      raw.send(hello);
      await raw.closed;
      expect(raw.replies[0]).toMatchObject({ ok: false, error });
    }
    const huge = rawConnection(pipe);
    opened.push(huge);
    huge.send(new Uint8Array(70_000));
    await huge.closed;
    expect(huge.replies).toEqual([]);
  });

  test('streams a session over an attach channel and hangs up on bad frames', async () => {
    const client = await ControlClient.connect(address());
    opened.push(client);
    const { id } = await client.create({ shell: 'cmd', cwd: tmpdir() });
    const channel = await AttachChannel.open(address(), { session: id, size: { cols: 90, rows: 25 } });
    opened.push(channel);
    const frames: Frame[] = [];
    channel.onFrame((frame) => frames.push(frame));
    let closed = false;
    channel.onClose(() => (closed = true));
    const text = () => frames.map((f) => (f.type === 'output' || f.type === 'snapshot' ? Buffer.from(f.data).toString('utf8') : '')).join('');
    await waitFor(() => frames[0]?.type === 'snapshot');
    // The pty takes the attaching client's size at a point in the stream, announced by a size frame.
    await waitFor(() => frames.some((frame) => frame.type === 'size' && frame.cols === 90 && frame.rows === 25));
    channel.sendRaw(encodeFrame({ type: 'input', data: Buffer.from('echo attached-%OS%\r') }));
    await waitFor(() => text().includes('attached-Windows_NT'));
    expect((await client.list())[0]?.attached).toBe(1);
    channel.sendRaw(Uint8Array.of(0x7f));
    await waitFor(() => closed);
    await waitFor(() => host.list()[0]?.attached === 0);
  }, SLOW);
});
