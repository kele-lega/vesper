import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const dirs: string[] = [];
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-config-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('reads the environment and keeps one token across restarts', () => {
    const env = {
      VESPER_HOME: home(),
      VESPER_PORT: '7700',
      VESPER_ORIGINS: 'https://v.example, https://w.example',
      VESPER_DEFAULT_CWD: 'C:\\work',
      VESPER_UI_DIST: 'C:\\ui',
    };
    const first = loadConfig(env);
    expect(first).toMatchObject({ port: 7700, bind: '127.0.0.1', defaultCwd: 'C:\\work', uiDist: 'C:\\ui' });
    expect(first.origins).toEqual(['http://127.0.0.1:7700', 'http://localhost:7700', 'https://v.example', 'https://w.example']);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(loadConfig(env).token).toBe(first.token);
  });

  test('replaces a damaged token file and has local defaults', () => {
    const dir = home();
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'token'), 'short');
    const config = loadConfig({ VESPER_HOME: dir });
    expect(config.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(config.port).toBe(7690);
    expect(config.origins).toEqual(['http://127.0.0.1:7690', 'http://localhost:7690']);
    expect(['D:\\code\\work_space', homedir()]).toContain(config.defaultCwd);
  });

  test.each(['abc', '-1', '70000', '1.5'])('rejects VESPER_PORT=%s', (port) => {
    expect(() => loadConfig({ VESPER_HOME: home(), VESPER_PORT: port })).toThrow(/VESPER_PORT/);
  });
});
