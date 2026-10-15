import { describe, expect, test } from 'vitest';
import { RingBuffer } from '../src/ring-buffer.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: Uint8Array | undefined): string | undefined =>
  value === undefined ? undefined : Buffer.from(value).toString('latin1');

describe('RingBuffer', () => {
  test('starts empty at offset 0', () => {
    const ring = new RingBuffer(8);
    expect([ring.start, ring.end]).toEqual([0, 0]);
    expect(ring.read(0)).toEqual(new Uint8Array(0));
    expect(ring.read(1)).toBeUndefined();
  });

  test('reads any retained range, optionally capped', () => {
    const ring = new RingBuffer(16);
    ring.append(Buffer.from('hello '));
    ring.append(Buffer.from('world'));
    expect(text(ring.read(0))).toBe('hello world');
    expect(text(ring.read(6))).toBe('world');
    expect(text(ring.read(2, 3))).toBe('llo');
    expect(ring.end).toBe(11);
  });

  test('keeps only the newest bytes after wrapping', () => {
    const ring = new RingBuffer(8);
    ring.append(Buffer.from('abcde'));
    ring.append(Buffer.from('fghij'));
    expect([ring.start, ring.end]).toEqual([2, 10]);
    expect(text(ring.read(2))).toBe('cdefghij');
    expect(text(ring.read(7, 2))).toBe('hi');
    expect(ring.read(1)).toBeUndefined();
    expect(ring.read(10)).toEqual(new Uint8Array(0));
  });

  test('keeps the tail of a single append larger than the capacity', () => {
    const ring = new RingBuffer(4);
    ring.append(Buffer.from('0123456789'));
    expect([ring.start, ring.end]).toEqual([6, 10]);
    expect(text(ring.read(6))).toBe('6789');
  });

  test('rejects offsets beyond the end', () => {
    const ring = new RingBuffer(4);
    ring.append(bytes(1, 2));
    expect(ring.read(3)).toBeUndefined();
  });

  test('returns copies that do not alias the buffer', () => {
    const ring = new RingBuffer(4);
    ring.append(bytes(1, 2, 3));
    const first = ring.read(0)!;
    first[0] = 9;
    expect(Array.from(ring.read(0)!)).toEqual([1, 2, 3]);
  });

  test('rejects a capacity below one byte', () => {
    expect(() => new RingBuffer(0)).toThrow(/capacity/);
  });
});
