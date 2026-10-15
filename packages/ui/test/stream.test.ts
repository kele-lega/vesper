import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AckScheduler, InputQueue, reconnectDelay, socketUrl } from '../src/stream.js';

describe('AckScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('acknowledges the newest parsed offset after the delay', () => {
    const sent: number[] = [];
    const acks = new AckScheduler(100, (seq) => sent.push(seq), 1000, 50);
    acks.parsedThrough(150);
    acks.parsedThrough(180);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([180]);
  });

  test('acknowledges at once when enough bytes are parsed', () => {
    const sent: number[] = [];
    const acks = new AckScheduler(0, (seq) => sent.push(seq), 1000, 50);
    acks.parsedThrough(400);
    acks.parsedThrough(1200);
    expect(sent).toEqual([1200]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1200]);
  });

  test('ignores offsets that do not advance and stops when disposed', () => {
    const sent: number[] = [];
    const acks = new AckScheduler(500, (seq) => sent.push(seq), 1000, 50);
    acks.parsedThrough(500);
    acks.parsedThrough(400);
    acks.flush();
    acks.parsedThrough(600);
    acks.dispose();
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);
  });
});

describe('InputQueue', () => {
  test('sends everything, in order, when the same shell answers in time', () => {
    let now = 0;
    const queue = new InputQueue(5000, () => now);
    queue.push('l');
    now = 1000;
    queue.push('s\r');
    expect(queue.size).toBe(2);
    expect(queue.take(true)).toEqual({ send: ['l', 's\r'], dropped: 0 });
    expect(queue.size).toBe(0);
  });

  test('drops everything once the oldest keystroke is too old', () => {
    let now = 0;
    const queue = new InputQueue(5000, () => now);
    queue.push('rm -rf ');
    now = 5500;
    queue.push('build\r');
    expect(queue.take(true)).toEqual({ send: [], dropped: 2 });
  });

  test('drops everything when a new shell answers', () => {
    const queue = new InputQueue();
    queue.push('y');
    expect(queue.take(false)).toEqual({ send: [], dropped: 1 });
    expect(queue.take(true)).toEqual({ send: [], dropped: 0 });
  });
});

describe('reconnectDelay', () => {
  test.each([
    [0, 0.5, 250],
    [1, 0.5, 500],
    [5, 0.5, 8000],
    [9, 0.5, 10_000],
    [0, 0, 200],
    [0, 1, 300],
  ])('attempt %i with random %f waits %f ms', (attempt, random, expected) => {
    expect(reconnectDelay(attempt, () => random)).toBeCloseTo(expected);
  });
});

describe('socketUrl', () => {
  test('uses wss behind https and carries the resume point and size', () => {
    expect(socketUrl({ protocol: 'https:', host: 'v.example' }, { session: 'abc', resume: { inc: 2, seq: 99 }, size: { cols: 80, rows: 24 } })).toBe(
      'wss://v.example/ws/sessions/abc?inc=2&seq=99&cols=80&rows=24',
    );
  });

  test('has no query without a resume point or size', () => {
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:7690' }, { session: 'abc' })).toBe('ws://127.0.0.1:7690/ws/sessions/abc');
  });
});
