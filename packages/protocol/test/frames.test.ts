import { describe, expect, test } from 'vitest';
import { decodeFrame, encodeFrame, FrameError, type Frame } from '../src/frames.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('frame codec', () => {
  const samples: Frame[] = [
    { type: 'input', data: bytes('ls\r') },
    { type: 'input', data: bytes('中文输入') },
    { type: 'resize', cols: 120, rows: 30 },
    { type: 'ack', seq: 65536 },
    { type: 'ping', nonce: 7 },
    { type: 'pong', nonce: 0xffffffff },
    { type: 'output', seq: 0, data: bytes('\x1b[32mok\x1b[0m\r\n') },
    { type: 'snapshot', inc: 3, seq: 1234, cols: 80, rows: 24, data: bytes('\x1b[H\x1b[2Jprompt> ') },
    { type: 'exit', code: -1073741510 },
    { type: 'size', cols: 100, rows: 40 },
    { type: 'closed', reason: 'removed' },
    { type: 'closed', reason: 'shutdown' },
    { type: 'closed', reason: 'restarted' },
  ];

  test.each(samples)('round-trips a $type frame', (frame) => {
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test('adds one byte of overhead to keystrokes', () => {
    expect(encodeFrame({ type: 'input', data: bytes('a') })).toHaveLength(2);
  });

  test('adds nine bytes of overhead to output chunks', () => {
    expect(encodeFrame({ type: 'output', seq: 42, data: bytes('abc') })).toHaveLength(12);
  });

  test('keeps sequence numbers exact up to MAX_SAFE_INTEGER', () => {
    const frame: Frame = { type: 'ack', seq: Number.MAX_SAFE_INTEGER };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test('round-trips empty payloads', () => {
    const frame: Frame = { type: 'output', seq: 9, data: new Uint8Array(0) };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
});

describe('decodeFrame rejects malformed input', () => {
  test('throws on an empty buffer', () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(FrameError);
  });

  test('throws on an unknown frame type', () => {
    expect(() => decodeFrame(Uint8Array.of(0x7f, 1, 2))).toThrow(/unknown frame type/);
  });

  test.each([
    ['resize', Uint8Array.of(0x02, 0, 80)],
    ['ack', Uint8Array.of(0x03, 0, 0, 0)],
    ['ping', Uint8Array.of(0x04, 1)],
    ['output', Uint8Array.of(0x81, 0, 0)],
    ['snapshot', Uint8Array.of(0x82, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 80, 0)],
    ['exit', Uint8Array.of(0x83, 0)],
    ['size', Uint8Array.of(0x84, 0, 80, 0)],
    ['closed', Uint8Array.of(0x85)],
  ])('throws on a truncated %s frame', (_name, frame) => {
    expect(() => decodeFrame(frame)).toThrow(/truncated/);
  });

  test('throws on fixed-size frames with trailing bytes', () => {
    expect(() => decodeFrame(Uint8Array.of(0x04, 0, 0, 0, 1, 9))).toThrow(/length/);
  });

  test('throws on sequence numbers beyond MAX_SAFE_INTEGER', () => {
    const frame = Uint8Array.of(0x03, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    expect(() => decodeFrame(frame)).toThrow(/sequence/);
  });

  test('throws on a zero-sized terminal', () => {
    expect(() => decodeFrame(Uint8Array.of(0x02, 0, 0, 0, 24))).toThrow(/size/);
  });

  test('throws on an unknown close reason', () => {
    expect(() => decodeFrame(Uint8Array.of(0x85, 9))).toThrow(/close reason/);
  });

  test('carries the snapshot header in 16 bytes', () => {
    const frame = encodeFrame({ type: 'snapshot', inc: 1, seq: 2, cols: 3, rows: 4, data: bytes('x') });
    expect(Array.from(frame.subarray(0, 17))).toEqual([0x82, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 3, 0, 4]);
  });
});

describe('encodeFrame rejects invalid values', () => {
  test.each<Frame>([
    { type: 'resize', cols: 0, rows: 24 },
    { type: 'resize', cols: 80, rows: 10001 },
    { type: 'resize', cols: 80.5, rows: 24 },
  ])('throws on terminal size $cols x $rows', (frame) => {
    expect(() => encodeFrame(frame)).toThrow(/size/);
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2])('throws on sequence %s', (seq) => {
    expect(() => encodeFrame({ type: 'ack', seq })).toThrow(/sequence/);
  });

  test('throws on a nonce outside u32', () => {
    expect(() => encodeFrame({ type: 'ping', nonce: 2 ** 32 })).toThrow(/nonce/);
  });

  test('throws on an exit code outside i32', () => {
    expect(() => encodeFrame({ type: 'exit', code: 2 ** 31 })).toThrow(/exit code/);
  });

  test.each([-1, 2 ** 32, 0.5])('throws on incarnation %s', (inc) => {
    const frame: Frame = { type: 'snapshot', inc, seq: 0, cols: 80, rows: 24, data: bytes('') };
    expect(() => encodeFrame(frame)).toThrow(/incarnation/);
  });

  test('throws on a size frame outside the terminal limits', () => {
    expect(() => encodeFrame({ type: 'size', cols: 0, rows: 1 })).toThrow(/size/);
  });
});
