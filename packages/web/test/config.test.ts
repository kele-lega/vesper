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

  test('reads the environment', () => {
    const dir = home();
    const env = {
      VESPER_HOME: dir,
      VESPER_PORT: '7700',
      VESPER_ORIGINS: 'https://v.example, https://w.example',
      VESPER_DEFAULT_CWD: 'C:\\work',
      VESPER_UI_DIST: 'C:\\ui',
      VESPER_WT_SETTINGS: 'none',
      VESPER_GIT_BASH: 'D:\\Git\\bin\\bash.exe',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    };
    const config = loadConfig(env);
    expect(config).toMatchObject({ port: 7690 + 10, bind: '127.0.0.1', defaultCwd: 'C:\\work', uiDist: 'C:\\ui' });
    expect(config.origins).toEqual(['http://127.0.0.1:7700', 'http://localhost:7700', 'https://v.example', 'https://w.example']);
    expect(config.database).toBe(join(dir, 'web', 'vesper.db'));
    expect(config.profileSources).toEqual({ wtSettings: undefined, appData: 'C:\\Users\\me\\AppData\\Roaming', gitBash: 'D:\\Git\\bin\\bash.exe' });
  });

  test('has local defaults, and finds Windows Terminal settings that exist', () => {
    const dir = home();
    const localAppData = join(dir, 'local');
    const settings = join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json');
    mkdirSync(join(localAppData, 'Microsoft', 'Windows Terminal'), { recursive: true });
    writeFileSync(settings, '{}');
    const config = loadConfig({ VESPER_HOME: dir, LOCALAPPDATA: localAppData });
    expect(config.port).toBe(7690);
    expect(config.origins).toEqual(['http://127.0.0.1:7690', 'http://localhost:7690']);
    expect(['D:\\code\\work_space', homedir()]).toContain(config.defaultCwd);
    expect(config.profileSources.wtSettings).toBe(settings);
    expect(config.profileSources.gitBash).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(loadConfig({ VESPER_HOME: dir, LOCALAPPDATA: join(dir, 'empty') }).profileSources.wtSettings).toBeUndefined();
  });

  test.each(['abc', '-1', '70000', '1.5'])('rejects VESPER_PORT=%s', (port) => {
    expect(() => loadConfig({ VESPER_HOME: home(), VESPER_PORT: port })).toThrow(/VESPER_PORT/);
  });
});
