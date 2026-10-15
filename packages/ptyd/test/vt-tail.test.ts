import { describe, expect, test } from 'vitest';
import { RingBuffer } from '../src/ring-buffer.js';
import { incompleteEscapeLength, openSequenceRemainder, snapshotCut } from '../src/vt-tail.js';

const tail = (value: string): number => incompleteEscapeLength(Buffer.from(value, 'utf8'));

describe('incompleteEscapeLength', () => {
  test.each([
    ['plain text', 'hello'],
    ['a complete CSI', '\x1b[31mred'],
    ['a complete private CSI', '\x1b[?25h'],
    ['an OSC ended by BEL', '\x1b]0;title\x07'],
    ['an OSC ended by ST', '\x1b]0;title\x1b\\'],
    ['a charset designation', '\x1b(B'],
    ['a two-byte escape', '\x1b7'],
    ['a CSI aborted by CAN', '\x1b[3\x18x'],
    ['text after a reset', '\x1b[0m中文'],
    ['a tail that starts inside an old sequence', '0mok'],
  ])('is 0 for %s', (_name, value) => {
    expect(tail(value)).toBe(0);
  });

  test.each([
    ['a lone ESC', 'abc\x1b', 1],
    ['a CSI without its final byte', 'abc\x1b[3', 3],
    ['a private CSI without its final byte', '\x1b[?25', 5],
    ['an OSC without a terminator', 'x\x1b]0;tit', 7],
    ['an OSC whose ST is cut after ESC', 'x\x1b]0;t\x1b', 6],
    ['a DCS without a terminator', '\x1bP$q', 4],
    ['a charset designation without its final byte', '\x1b(', 2],
  ])('covers %s', (_name, value, expected) => {
    expect(tail(value)).toBe(expected);
  });

  test('counts UTF-8 bytes inside an unterminated OSC', () => {
    expect(tail('\x1b]0;中')).toBe(7);
  });
});

describe('openSequenceRemainder', () => {
  const remainder = (open: string, next: string) =>
    openSequenceRemainder(Buffer.from(open, 'utf8'), Buffer.from(next, 'utf8'));

  test.each([
    ['a CSI finished by its final byte', '\x1b[38;2', ';1;2mtext', 5],
    ['a lone ESC finished as a CSI', '\x1b', '[31mtext', 4],
    ['a lone ESC finished as a two-byte escape', '\x1b', '7text', 1],
    ['a lone ESC finished as an OSC', '\x1b', ']0;t\x07rest', 5],
    ['an OSC finished by BEL', '\x1b]0;ti', 'tle\x07x', 4],
    ['an OSC finished by ST', '\x1b]0;ti', 'tle\x1b\\x', 5],
    ['an OSC whose ESC turns out to be ST', '\x1b]0;t\x1b', '\\x', 1],
    ['an OSC cut short by a new sequence', '\x1b]0;', 'x\x1b[1m', 1],
    ['a CSI aborted at once by ESC', '\x1b[3', '\x1b[1m', 0],
    ['a CSI aborted by CAN', '\x1b[3', '\x18x', 1],
    ['a charset designation', '\x1b(', 'Bx', 1],
  ])('%s', (_name, open, next, expected) => {
    expect(remainder(open, next)).toBe(expected);
  });

  test.each([
    ['an empty next chunk', '\x1b[3', ''],
    ['a CSI still open', '\x1b[3', '8;2;1'],
    ['an OSC still open', '\x1b]0;', 'still going'],
    ['an OSC whose ESC is the last byte so far', '\x1b]0;t', 'x\x1b'],
  ])('is undefined for %s', (_name, open, next) => {
    expect(remainder(open, next)).toBeUndefined();
  });
});

describe('snapshotCut', () => {
  const ringWith = (value: string, capacity = 1024): RingBuffer => {
    const ring = new RingBuffer(capacity);
    ring.append(Buffer.from(value, 'utf8'));
    return ring;
  };

  test('keeps the end when the output ends cleanly', () => {
    const ring = ringWith('ok\x1b[0m');
    expect(snapshotCut(ring, ring.end)).toBe(ring.end);
  });

  test('moves back to the start of an open sequence', () => {
    const ring = ringWith('ok\x1b]0;tit');
    expect(snapshotCut(ring, ring.end)).toBe(2);
  });

  test('cuts relative to the given end, not the newest byte', () => {
    const ring = ringWith('ok\x1b[3');
    ring.append(Buffer.from('1mnext'));
    expect(snapshotCut(ring, 5)).toBe(2);
  });

  test('keeps the end when the open sequence began before the retained bytes', () => {
    const ring = ringWith('\x1b]0;' + 'x'.repeat(20), 8);
    expect(snapshotCut(ring, ring.end)).toBe(ring.end);
  });
});
