import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { hostPaths, readRunInfo, removeRunInfo, vesperHome, writeRunInfo } from '../src/paths.js';

describe('host paths', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('the home is VESPER_HOME, else %LOCALAPPDATA%\\vesper', () => {
    expect(vesperHome({ VESPER_HOME: 'X:\\home' })).toBe('X:\\home');
    expect(vesperHome({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32')).toBe(join('C:\\Users\\me\\AppData\\Local', 'vesper'));
  });

  test('each home gets its own pipe, whatever the letter case', () => {
    const home = hostPaths('C:\\Home', 'win32');
    expect(hostPaths('c:\\home', 'win32').pipe).toBe(home.pipe);
    expect(hostPaths('C:\\Other', 'win32').pipe).not.toBe(home.pipe);
    expect(home.pipe).toMatch(/^\\\\\.\\pipe\\vesper-ptyd-[0-9a-f]{16}$/);
    expect(home.runFile).toBe(join('C:\\Home', 'run', 'ptyd.json'));
    expect(home.dataDir).toBe(join('C:\\Home', 'data'));
  });

  test('run files round-trip and are removed only by the process they describe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-paths-'));
    dirs.push(dir);
    const path = join(dir, 'run', 'ptyd.json');
    const info = { pid: 1234, pipe: '\\\\.\\pipe\\x', token: 't', protocol: 1, startedAt: 5 };
    expect(readRunInfo(path)).toBeUndefined();
    writeRunInfo(path, info);
    expect(readRunInfo(path)).toEqual(info);
    removeRunInfo(path, 999);
    expect(readRunInfo(path)).toEqual(info);
    removeRunInfo(path, 1234);
    expect(readRunInfo(path)).toBeUndefined();
  });

  test.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['a bad pid', JSON.stringify({ pid: 'x', pipe: 'p', token: 't', protocol: 1, startedAt: 1 })],
    ['a bad protocol', JSON.stringify({ pid: 1, pipe: 'p', token: 't', protocol: -1, startedAt: 1 })],
  ])('ignores a run file holding %s', (_name, content) => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-paths-'));
    dirs.push(dir);
    const path = join(dir, 'ptyd.json');
    writeFileSync(path, content);
    expect(readRunInfo(path)).toBeUndefined();
  });
});
