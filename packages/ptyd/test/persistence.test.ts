import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionFiles, type Checkpoint } from '../src/persistence.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const asText = (data: Uint8Array) => Buffer.from(data).toString('utf8');
const SIZE = { cols: 80, rows: 24 };
const tailText = (tail: { parts: { data: Uint8Array }[] }) => tail.parts.map((part) => asText(part.data)).join('');
const checkpoint = (inc: number, seq: number, data = `screen@${seq}`): Checkpoint => ({
  inc,
  seq,
  cols: 80,
  rows: 24,
  data,
  savedAt: 1,
});

describe('SessionFiles', () => {
  const dirs: string[] = [];
  const create = (): SessionFiles => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-files-'));
    dirs.push(dir);
    return new SessionFiles(join(dir, 'session'));
  };
  const segmentNames = (files: SessionFiles) => readdirSync(files.dir).filter((name) => name.endsWith('.log')).sort();

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips a checkpoint with non-ASCII screen data', () => {
    const files = create();
    expect(files.writeCheckpoint(checkpoint(2, 10, '\x1b[31m中文\x1b[0m'))).toBe(true);
    expect(files.readCheckpoint()).toEqual(checkpoint(2, 10, '\x1b[31m中文\x1b[0m'));
  });

  test('logs contiguous output in one segment and reads it from any offset', () => {
    const files = create();
    files.append(1, 0, bytes('hello '), SIZE);
    files.append(1, 6, bytes('world'), SIZE);
    expect(files.bufferedBytes).toBe(11);
    files.flush();
    files.append(1, 11, bytes('!'), SIZE);
    files.flush();
    expect(segmentNames(files)).toEqual(['out-1-0-80x24.log']);
    expect(tailText(files.readTail(1, 0, 100))).toBe('hello world!');
    expect(files.readTail(1, 6, 100)).toEqual({ inc: 1, from: 6, bytes: 6, parts: [{ ...SIZE, data: bytes('world!') }] });
    expect(tailText(files.readTail(1, 2, 3))).toBe('llo');
  });

  test('a checkpoint starts a new segment and drops the ones it covers', () => {
    const files = create();
    files.append(1, 0, bytes('abcdef'), SIZE);
    files.writeCheckpoint(checkpoint(1, 4));
    expect(segmentNames(files)).toEqual(['out-1-0-80x24.log']);
    files.append(1, 6, bytes('gh'), SIZE);
    files.writeCheckpoint(checkpoint(1, 8));
    expect(segmentNames(files)).toEqual([]);
    files.append(1, 8, bytes('ij'), SIZE);
    files.flush();
    expect(segmentNames(files)).toEqual(['out-1-8-80x24.log']);
  });

  test('replays across segments from the checkpoint offset', () => {
    const files = create();
    files.append(1, 0, bytes('abcdef'), SIZE);
    files.writeCheckpoint(checkpoint(1, 4));
    files.append(1, 6, bytes('gh'), SIZE);
    files.flush();
    expect(tailText(files.readTail(1, 4, 100))).toBe('efgh');
  });

  test('stops at a hole in the log', () => {
    const files = create();
    files.append(1, 0, bytes('abc'), SIZE);
    files.append(1, 10, bytes('xyz'), SIZE);
    files.flush();
    expect(segmentNames(files)).toEqual(['out-1-0-80x24.log', 'out-1-10-80x24.log']);
    expect(tailText(files.readTail(1, 0, 100))).toBe('abc');
  });

  test('keeps incarnations apart and prunes older ones at the next checkpoint', () => {
    const files = create();
    files.append(1, 0, bytes('old'), SIZE);
    files.append(2, 0, bytes('new'), SIZE);
    files.flush();
    expect(files.latestLoggedInc()).toBe(2);
    expect(tailText(files.readTail(1, undefined, 100))).toBe('old');
    files.writeCheckpoint(checkpoint(2, 0));
    expect(segmentNames(files)).toEqual(['out-2-0-80x24.log']);
  });

  test('reads from the oldest kept byte when there is no checkpoint', () => {
    const files = create();
    files.append(3, 50, bytes('tail'), SIZE);
    files.flush();
    expect(files.readTail(3, undefined, 100)).toEqual({ inc: 3, from: 50, bytes: 4, parts: [{ ...SIZE, data: bytes('tail') }] });
    expect(files.readTail(4, undefined, 100)).toEqual({ inc: 4, from: 0, bytes: 0, parts: [] });
  });

  test('truncates a stale segment file instead of appending to it', () => {
    const files = create();
    writeFileSync(join(files.dir, 'out-1-0-80x24.log'), 'stale bytes');
    files.append(1, 0, bytes('fresh'), SIZE);
    files.flush();
    expect(tailText(files.readTail(1, 0, 100))).toBe('fresh');
  });

  test.each([
    ['not JSON', '{'],
    ['an unknown version', JSON.stringify({ v: 9, ...checkpoint(1, 1) })],
    ['a bad field', JSON.stringify({ v: 1, ...checkpoint(1, 1), cols: 0 })],
  ])('ignores a checkpoint that is %s', (_name, content) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const files = create();
    writeFileSync(join(files.dir, 'checkpoint.json'), content);
    expect(files.readCheckpoint()).toBeUndefined();
  });

  test('has nothing to read in a fresh directory', () => {
    const files = create();
    expect(files.readCheckpoint()).toBeUndefined();
    expect(files.latestLoggedInc()).toBeUndefined();
  });

  test('a failed log write leaves a hole that replay stops at', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const files = create();
    files.append(1, 0, bytes('ab'), SIZE);
    files.flush();
    mkdirSync(join(files.dir, 'out-1-5-80x24.log')); // the next segment cannot be written
    files.append(1, 5, bytes('zz'), SIZE);
    files.flush();
    files.append(1, 7, bytes('yy'), SIZE);
    files.flush();
    expect(tailText(files.readTail(1, 0, 100))).toBe('ab');
    expect(tailText(files.readTail(1, 7, 100))).toBe('yy');
  });

  test('a failed checkpoint keeps the previous one and the log', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const files = create();
    files.writeCheckpoint(checkpoint(1, 0));
    files.append(1, 0, bytes('abc'), SIZE);
    mkdirSync(join(files.dir, 'checkpoint.json.tmp'));
    expect(files.writeCheckpoint(checkpoint(1, 3))).toBe(false);
    expect(files.readCheckpoint()?.seq).toBe(0);
    expect(tailText(files.readTail(1, 0, 100))).toBe('abc');
  });

  test('a size change starts a new segment, and the tail keeps each part with its size', () => {
    const files = create();
    files.append(1, 0, bytes('wide'), { cols: 120, rows: 30 });
    files.append(1, 4, bytes('narrow'), { cols: 80, rows: 24 });
    files.append(1, 10, bytes('!'), { cols: 80, rows: 24 });
    files.flush();
    expect(segmentNames(files)).toEqual(['out-1-0-120x30.log', 'out-1-4-80x24.log']);
    expect(files.readTail(1, 2, 100).parts).toEqual([
      { cols: 120, rows: 30, data: bytes('de') },
      { cols: 80, rows: 24, data: bytes('narrow!') },
    ]);
  });

  test('remove deletes the directory and drops queued output', async () => {
    const files = create();
    files.append(1, 0, bytes('abc'), SIZE);
    const removed = files.remove();
    expect(files.bufferedBytes).toBe(0);
    await removed;
    expect(existsSync(files.dir)).toBe(false);
  });
});
