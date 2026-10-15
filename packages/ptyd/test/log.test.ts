import { afterEach, describe, expect, test } from 'vitest';
import { Listeners, log, setLogSink } from '../src/log.js';

describe('log', () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const capture = (): string[] => {
    const lines: string[] = [];
    const previous = setLogSink((line) => lines.push(line));
    restore = () => setLogSink(previous);
    return lines;
  };

  test('writes the level, message and details, errors with their stack', () => {
    const lines = capture();
    log.info('ready', { sessions: 2 });
    log.warn('slow', new Error('boom'));
    log.error('failed');
    expect(lines[0]).toMatch(/^\S+ info ready \{ sessions: 2 \}$/);
    expect(lines[1]).toMatch(/ warn slow Error: boom\n\s+at /);
    expect(lines[2]).toMatch(/ error failed$/);
  });

  test('listeners: a failing one is logged and the rest still run; unsubscribe and clear work', () => {
    const lines = capture();
    const listeners = new Listeners<number>('test');
    const seen: number[] = [];
    listeners.add(() => {
      throw new Error('bad listener');
    });
    const off = listeners.add((value) => seen.push(value));
    listeners.emit(1);
    off();
    listeners.emit(2);
    expect(seen).toEqual([1]);
    expect(lines.some((line) => line.includes('test listener failed'))).toBe(true);
    expect(listeners.size).toBe(1);
    listeners.clear();
    expect(listeners.size).toBe(0);
  });
});
