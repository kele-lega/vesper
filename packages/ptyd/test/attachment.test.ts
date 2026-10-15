import { describe, expect, test, vi } from 'vitest';
import type { Frame } from '@vesper/protocol';
import { Attachment, type AttachmentHooks, type AttachmentOptions, type OutputSource } from '../src/attachment.js';
import type { OutputChunk, SizeEvent, Snapshot } from '../src/session.js';

class FakeSource implements OutputSource {
  seq = 0;
  start = 0;
  exitCode: number | undefined;
  snapshots = 0;
  events: SizeEvent[] = [{ id: 0, seq: 0, cols: 80, rows: 24 }];
  private bytes: number[] = [];
  private readonly outputs = new Set<(chunk: OutputChunk) => void>();
  private readonly sizes = new Set<(event: SizeEvent) => void>();
  private readonly exits = new Set<(code: number) => void>();

  get size() {
    const { cols, rows } = this.events.at(-1)!;
    return { cols, rows };
  }

  private nextId = 1;

  resize(cols: number, rows: number): void {
    const event = { id: this.nextId++, seq: this.seq, cols, rows };
    this.events.push(event);
    for (const listener of this.sizes) listener(event);
  }

  sizeAt(seq: number): SizeEvent {
    return this.events.filter((event) => event.seq <= seq).at(-1) ?? this.events[0]!;
  }

  sizeEventsAfter(id: number): SizeEvent[] {
    return this.events.filter((event) => event.id > id);
  }

  onSize(listener: (event: SizeEvent) => void): () => void {
    this.sizes.add(listener);
    return () => this.sizes.delete(listener);
  }

  push(text: string): void {
    const data = Buffer.from(text, 'latin1');
    const chunk = { seq: this.seq, data };
    this.bytes.push(...data);
    this.seq += data.length;
    for (const listener of this.outputs) listener(chunk);
  }

  forgetBefore(seq: number): void {
    this.start = seq;
  }

  exit(code: number): void {
    this.exitCode = code;
    for (const listener of this.exits) listener(code);
  }

  read(from: number, max = Infinity): Uint8Array | undefined {
    if (from < this.start || from > this.seq) return undefined;
    return Uint8Array.from(this.bytes.slice(from, Math.min(this.seq, from + max)));
  }

  async snapshot(): Promise<Snapshot> {
    this.snapshots++;
    return { seq: this.seq, ...this.size, data: `screen@${this.seq}`, sizeEventId: this.events.at(-1)!.id };
  }

  onOutput(listener: (chunk: OutputChunk) => void): () => void {
    this.outputs.add(listener);
    return () => this.outputs.delete(listener);
  }

  onExit(listener: (code: number) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (data: Uint8Array) => Buffer.from(data).toString('latin1');

function describeFrames(frames: Frame[]): string[] {
  return frames.map((frame) => {
    switch (frame.type) {
      case 'output':
        return `output@${frame.seq}:${text(frame.data)}`;
      case 'snapshot':
        return `snapshot#${frame.inc}@${frame.seq}:${text(frame.data)}`;
      case 'size':
        return `size ${frame.cols}x${frame.rows}`;
      case 'exit':
        return `exit ${frame.code}`;
      case 'closed':
        return `closed ${frame.reason}`;
      default:
        return frame.type;
    }
  });
}

function setup(options: Partial<AttachmentOptions> = {}, source = new FakeSource()) {
  const frames: Frame[] = [];
  const peer = { send: (frame: Frame) => frames.push(frame), close: vi.fn() };
  const hooks: AttachmentHooks = { input: vi.fn(), resize: vi.fn() };
  const attachment = new Attachment(source, peer, hooks, { inc: 1, ...options });
  return { source, frames, peer, hooks, attachment, sent: () => describeFrames(frames) };
}

describe('Attachment resume', () => {
  test('resumes from the client seq with only the missing bytes', () => {
    const source = new FakeSource();
    source.push('hello world');
    const { attachment, sent } = setup({ resume: { inc: 1, seq: 6 } }, source);
    attachment.start();
    expect(sent()).toEqual(['size 80x24', 'output@6:world']);
  });

  test.each([
    ['another incarnation', { inc: 2, seq: 6 }, 0],
    ['output that has left the ring', { inc: 1, seq: 2 }, 5],
    ['a seq beyond the stream', { inc: 1, seq: 99 }, 0],
  ])('sends a snapshot instead of resuming from %s', async (_name, resume, forgotten) => {
    const source = new FakeSource();
    source.push('hello world');
    source.forgetBefore(forgotten);
    const { attachment, sent } = setup({ resume }, source);
    attachment.start();
    await settle();
    expect(sent()).toEqual(['snapshot#1@11:screen@11']);
  });

  test('without a resume point starts with a snapshot, then streams everything after it', async () => {
    const { source, attachment, sent } = setup();
    attachment.start();
    source.push('during');
    await settle();
    source.push('after');
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:during', 'output@6:after']);
  });
});

describe('Attachment flow control', () => {
  test('stops at the window and continues as acks arrive', async () => {
    const { source, attachment, sent } = setup({ window: 4, maxFrame: 3 });
    attachment.start();
    await settle();
    source.push('abcdefghij');
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:abc', 'output@3:d']);
    attachment.receive({ type: 'ack', seq: 3 });
    expect(sent().slice(3)).toEqual(['output@4:efg']);
    attachment.receive({ type: 'ack', seq: 7 });
    expect(sent().slice(4)).toEqual(['output@7:hij']);
  });

  test('ignores stale and repeated acks', async () => {
    const { source, attachment, sent } = setup({ window: 2 });
    attachment.start();
    await settle();
    source.push('abcd');
    attachment.receive({ type: 'ack', seq: 2 });
    attachment.receive({ type: 'ack', seq: 2 });
    attachment.receive({ type: 'ack', seq: 1 });
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:ab', 'output@2:cd']);
  });

  test('a client left behind by the ring gets one snapshot once it catches up', async () => {
    const { source, attachment, sent } = setup({ window: 4 });
    attachment.start();
    await settle();
    source.push('abcdefgh');
    source.forgetBefore(6);
    source.push('ij');
    expect(source.snapshots).toBe(1);
    attachment.receive({ type: 'ack', seq: 4 });
    await settle();
    expect(source.snapshots).toBe(2);
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:abcd', 'snapshot#1@10:screen@10']);
  });

  test('closes on an ack for output never sent', async () => {
    const { source, attachment, peer } = setup();
    attachment.start();
    await settle();
    source.push('ab');
    attachment.receive({ type: 'ack', seq: 5 });
    expect(peer.close).toHaveBeenCalled();
  });
});

describe('Attachment lifecycle', () => {
  test('sends exit only after all output', async () => {
    const { source, attachment, sent } = setup({ window: 2 });
    attachment.start();
    await settle();
    source.push('abcd');
    source.exit(3);
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:ab']);
    attachment.receive({ type: 'ack', seq: 2 });
    expect(sent().slice(2)).toEqual(['output@2:cd', 'exit 3']);
  });

  test('a session that already exited gets its snapshot and then exit', async () => {
    const source = new FakeSource();
    source.push('done');
    source.exit(0);
    const { attachment, sent } = setup({}, source);
    attachment.start();
    await settle();
    expect(sent()).toEqual(['snapshot#1@4:screen@4', 'exit 0']);
  });

  test('a size change is sent where it happened in the stream, even when the window holds output back', async () => {
    const { source, attachment, sent } = setup({ window: 4 });
    attachment.start();
    await settle();
    source.push('abcdef');
    source.resize(100, 40);
    source.push('gh');
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:abcd']);
    attachment.receive({ type: 'ack', seq: 4 });
    expect(sent().slice(2)).toEqual(['output@4:ef', 'size 100x40', 'output@6:gh']);
  });

  test('a snapshot that already shows a size change does not repeat it', async () => {
    const source = new FakeSource();
    source.push('ab');
    source.resize(100, 40);
    const { attachment, sent } = setup({}, source);
    attachment.start();
    await settle();
    source.resize(120, 50);
    expect(sent()).toEqual(['snapshot#1@2:screen@2', 'size 120x50']);
  });

  test('resuming sends the size at the resume point, then the changes after it', () => {
    const source = new FakeSource();
    source.push('ab');
    source.resize(100, 40);
    source.push('cd');
    source.resize(90, 30);
    const { attachment, sent } = setup({ resume: { inc: 1, seq: 3 } }, source);
    attachment.start();
    expect(sent()).toEqual(['size 100x40', 'output@3:d', 'size 90x30']);
  });

  test('a client that needs a size change no longer kept gets a snapshot', async () => {
    const { source, attachment, sent } = setup({ window: 2 });
    attachment.start();
    await settle();
    source.push('abcd');
    source.resize(100, 40);
    source.events.splice(1, 1); // pruned, as when the ring has moved on
    source.resize(90, 30);
    attachment.receive({ type: 'ack', seq: 2 });
    await settle();
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'output@0:ab', 'snapshot#1@4:screen@4']);
  });

  test('closing with a reason tells the peer and stops streaming', async () => {
    const { source, attachment, peer, sent } = setup();
    attachment.start();
    await settle();
    attachment.close('removed');
    source.push('late');
    source.resize(10, 10);
    expect(sent()).toEqual(['snapshot#1@0:screen@0', 'closed removed']);
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  test('a snapshot that fails closes the attachment', async () => {
    const source = new FakeSource();
    source.snapshot = () => Promise.reject(new Error('mirror gone'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { attachment, peer } = setup({}, source);
    attachment.start();
    await settle();
    expect(peer.close).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('Attachment input', () => {
  test('decodes UTF-8 split across frames and forwards resizes', () => {
    const { attachment, hooks } = setup();
    const bytes = Buffer.from('中a', 'utf8');
    attachment.receive({ type: 'input', data: bytes.subarray(0, 2) });
    attachment.receive({ type: 'input', data: bytes.subarray(2) });
    attachment.receive({ type: 'resize', cols: 90, rows: 20 });
    expect(hooks.input).toHaveBeenCalledTimes(1);
    expect(hooks.input).toHaveBeenCalledWith(attachment, '中a');
    expect(hooks.resize).toHaveBeenCalledWith(attachment, { cols: 90, rows: 20 });
  });

  test('closes on frames that do not belong on an attach channel', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { attachment, peer } = setup();
    attachment.receive({ type: 'ping', nonce: 1 });
    expect(peer.close).toHaveBeenCalled();
    logged.mockRestore();
  });
});
