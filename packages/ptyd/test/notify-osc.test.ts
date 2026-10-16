import { describe, expect, test } from 'vitest';
import { NoticeLimiter, parseOsc777, parseOsc9, safeText } from '../src/notify-osc.js';

describe('parseOsc9', () => {
  test('reads the text as the body', () => {
    expect(parseOsc9('Codex wants to run a command')).toEqual({ title: '', body: 'Codex wants to run a command' });
  });

  test('ignores ConEmu subcommands', () => {
    for (const data of ['4;1;50', '9;C:\\work', '1', '12']) expect(parseOsc9(data)).toBeUndefined();
  });

  test('keeps text that only starts with a digit', () => {
    expect(parseOsc9('3 tests failed')).toEqual({ title: '', body: '3 tests failed' });
  });

  test('ignores empty text and strips control and bidi characters', () => {
    expect(parseOsc9('  ')).toBeUndefined();
    expect(parseOsc9('done\u0007\u202e!')).toEqual({ title: '', body: 'done!' });
  });

  test('bounds the length', () => {
    expect(parseOsc9('x'.repeat(2000))!.body).toHaveLength(512);
  });
});

describe('parseOsc777', () => {
  test('reads title and body; the body may contain semicolons', () => {
    expect(parseOsc777('notify;Build;failed; see log')).toEqual({ title: 'Build', body: 'failed; see log' });
  });

  test('accepts a title alone', () => {
    expect(parseOsc777('notify;Done')).toEqual({ title: 'Done', body: '' });
  });

  test('ignores other 777 commands and empty notifications', () => {
    expect(parseOsc777('precmd')).toBeUndefined();
    expect(parseOsc777('notify;;')).toBeUndefined();
  });
});

test('safeText strips unsafe characters and bounds the length', () => {
  expect(safeText('a\u0000b\u200fc', 2)).toBe('ab');
});

describe('NoticeLimiter', () => {
  test('allows a burst, then one more per interval', () => {
    const limiter = new NoticeLimiter(3, 1000);
    expect([0, 1, 2, 3].map((at) => limiter.allow(at))).toEqual([true, true, true, false]);
    expect(limiter.allow(999)).toBe(false);
    expect(limiter.allow(1000)).toBe(true);
    expect(limiter.allow(1001)).toBe(false);
  });

  test('refills up to the burst after a quiet spell', () => {
    const limiter = new NoticeLimiter(2, 1000);
    expect([0, 0, 0].map((at) => limiter.allow(at))).toEqual([true, true, false]);
    expect([60_000, 60_000, 60_000].map((at) => limiter.allow(at))).toEqual([true, true, false]);
  });
});
