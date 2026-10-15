import { describe, expect, test } from 'vitest';
import type { Frame } from '@vesper/protocol';
import { attachClient, type AttachableSession } from '../src/attach.js';

const bytes = (text: string) => new TextEncoder().encode(text);

function fakeSession(seq = 0) {
  const outputs = new Set<(chunk: { seq: number; data: Uint8Array }) => void>();
  const exits = new Set<(code: number) => void>();
  let exitCode: number | undefined;
  let resolveSnapshot: ((value: { seq: number; cols: number; rows: number; data: string }) => void) | undefined;
  const session: AttachableSession = {
    onOutput: (listener) => (outputs.add(listener), () => outputs.delete(listener)),
    onExit: (listener) => {
      if (exitCode !== undefined) {
        const code = exitCode;
        queueMicrotask(() => listener(code));
        return () => undefined;
      }
      exits.add(listener);
      return () => exits.delete(listener);
    },
    snapshot: () => {
      const at = seq;
      return new Promise((resolve) => (resolveSnapshot = (value) => resolve({ ...value, seq: at })));
    },
  };
  return {
    session,
    emit(text: string) {
      const chunk = { seq, data: bytes(text) };
      seq += chunk.data.length;
      for (const listener of outputs) listener(chunk);
    },
    exit(code: number) {
      exitCode = code;
      for (const listener of exits) listener(code);
    },
    finishSnapshot: () => resolveSnapshot?.({ seq: 0, cols: 80, rows: 24, data: 'screen' }),
    listenerCount: () => outputs.size + exits.size,
  };
}

function client() {
  const frames: Frame[] = [];
  let closed = 0;
  return { frames, send: (frame: Frame) => frames.push(frame), close: () => closed++, closed: () => closed };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const describeFrames = (frames: Frame[]) =>
  frames.map((f) => (f.type === 'output' ? `output@${f.seq}` : f.type === 'snapshot' ? `snapshot@${f.seq}` : f.type));

describe('attachClient', () => {
  test('sends the snapshot first and only output it does not contain', async () => {
    const fake = fakeSession();
    fake.emit('before');
    const peer = client();
    attachClient(fake.session, peer);
    fake.emit('during');
    fake.finishSnapshot();
    await flush();
    fake.emit('after');
    expect(describeFrames(peer.frames)).toEqual(['snapshot@6', 'output@6', 'output@12']);
  });

  test('queues an exit that happens before the snapshot is sent, then closes', async () => {
    const fake = fakeSession();
    const peer = client();
    attachClient(fake.session, peer);
    fake.emit('last words');
    fake.exit(3);
    expect(peer.frames).toEqual([]);
    fake.finishSnapshot();
    await flush();
    expect(describeFrames(peer.frames)).toEqual(['snapshot@0', 'output@0', 'exit']);
    expect(peer.frames.at(-1)).toEqual({ type: 'exit', code: 3 });
    expect(peer.closed()).toBe(1);
  });

  test('a session that already exited still sends its last screen, then exit', async () => {
    const fake = fakeSession();
    fake.exit(0);
    const peer = client();
    attachClient(fake.session, peer);
    fake.finishSnapshot();
    await flush();
    expect(describeFrames(peer.frames)).toEqual(['snapshot@0', 'exit']);
    expect(peer.closed()).toBe(1);
  });

  test('sends nothing after detach, even when the snapshot resolves later', async () => {
    const fake = fakeSession();
    const peer = client();
    const detach = attachClient(fake.session, peer);
    detach();
    fake.emit('ignored');
    fake.finishSnapshot();
    await flush();
    expect(peer.frames).toEqual([]);
    expect(fake.listenerCount()).toBe(0);
  });

  test('stops forwarding after detach', async () => {
    const fake = fakeSession();
    const peer = client();
    const detach = attachClient(fake.session, peer);
    fake.finishSnapshot();
    await flush();
    fake.emit('one');
    detach();
    fake.emit('two');
    expect(describeFrames(peer.frames)).toEqual(['snapshot@0', 'output@0']);
  });
});
