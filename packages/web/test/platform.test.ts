import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isLinuxClaudeProcess, parseLinuxStartTime } from '../src/external-sessions.js';
import { listFolders, localDrives, localFolder } from '../src/folders.js';
import { defaultProfiles, ProfileStore } from '../src/profile-store.js';
import { ProjectStore } from '../src/project-store.js';
import { folderName, route, type RouteDeps } from '../src/web-routes.js';
import { SettingsStore } from '../src/settings-store.js';
import { openWebDatabase } from '../src/web-db.js';
import { worktreePath } from '../src/worktree.js';

const dirs: string[] = [];
const databases: DatabaseSync[] = [];
const database = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-platform-'));
  dirs.push(dir);
  const db = openWebDatabase(join(dir, 'web.db'));
  databases.push(db);
  return db;
};
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Linux web platform', () => {
  test('uses home and PATH, never imports Windows Terminal even if configured', () => {
    const config = loadConfig({ VESPER_HOME: '/tmp/vesper', VESPER_WT_SETTINGS: '/tmp/windows.json', PATH: '/opt/bin:/usr/bin', SHELL: '/bin/zsh' }, 'linux');
    expect(config.platform).toBe('linux');
    expect(config.defaultCwd).toBe(homedir());
    expect(config.profileSources).toMatchObject({ wtSettings: undefined, path: '/opt/bin:/usr/bin', shell: '/bin/zsh' });
    expect(localDrives('linux')).toEqual(['/']);
  });

  test('seeds available Unix shells and executable PATH agents with normal privilege', () => {
    const installed = new Set(['/bin/sh', '/bin/bash', '/opt/bin/zsh', '/opt/bin/claude', '/usr/bin/codex']);
    const profiles = defaultProfiles([{ name: 'Windows', launch: { shell: 'cmd' } }], {
      platform: 'linux', appData: '', gitBash: '', path: '/opt/bin:/usr/bin:/bin', shell: '/opt/bin/zsh', exists: (path) => installed.has(path),
      executable: (path) => installed.has(path),
    });
    expect(profiles.map((profile) => profile.name)).toEqual(['Zsh', 'Bash', 'sh', 'Claude Code', 'Codex']);
    expect(profiles.every((profile) => profile.elevation === 'normal' && profile.source === 'builtin')).toBe(true);
    expect(profiles.find((profile) => profile.agent === 'claude')?.launch).toEqual({ command: { file: '/opt/bin/claude', args: [] } });
    expect(profiles.some((profile) => profile.agent === 'gemini')).toBe(false);
  });

  test('stores case-sensitive POSIX directories and matches boundaries without folding case', () => {
    const store = new ProjectStore(database(), () => 1, 'linux');
    const upper = store.create('upper', '/home/me/Code/');
    const lower = store.create('lower', '/home/me/code');
    const nested = store.create('nested', '/home/me/Code/../Code/sub');
    expect(upper.path).toBe('/home/me/Code');
    expect(lower.path).toBe('/home/me/code');
    expect(store.forDirectory('/home/me/Code/sub/file')?.id).toBe(nested.id);
    expect(store.forDirectory('/home/me/code/file')?.id).toBe(lower.id);
    expect(store.forDirectory('/home/me/CODE')).toBeUndefined();
    expect(store.forDirectory('/home/me/Code2')).toBeUndefined();
    expect(() => store.create('duplicate', '/home/me/Code/')).toThrow(/already/);
    expect(() => store.create('bad', 'D:\\code')).toThrow(/absolute/);
  });

  test('normalizes both legacy and newly edited profiles before session creation', () => {
    const db = database();
    const windows = new ProfileStore(db, () => 1, 'win32');
    const stored = windows.add({ name: 'Bash', launch: { shell: 'bash' }, agent: null, elevation: 'admin', source: 'user', wtGuid: null });
    const unix = new ProfileStore(db, () => 1, 'linux');
    expect(unix.get(stored.id)?.elevation).toBe('normal');
    expect(unix.createOptions(stored.id)).toEqual({ shell: 'bash', elevation: 'normal' });
    expect(unix.update(stored.id, { ...stored, elevation: 'admin' })?.elevation).toBe('normal');
    expect(unix.add({ ...stored, name: 'new', elevation: 'admin' }).elevation).toBe('normal');
  });

  test('routes expose server platform and create a project with native separators', async () => {
    const db = database();
    const root = dirs.at(-1)!;
    const settings = new SettingsStore(db, root);
    const projects = new ProjectStore(db, () => 1, process.platform);
    const deps = { platform: process.platform, settings, projects, hub: { projectsChanged: vi.fn() } } as unknown as RouteDeps;
    const request = { body: async () => ({ name: 'new-project' }), query: new URLSearchParams() };
    expect(await route(deps, 'GET', '/api/config', request)).toMatchObject([200, { platform: process.platform }]);
    const result = await route(deps, 'POST', '/api/projects', request);
    expect(result).toMatchObject([201, { project: { path: join(root, 'new-project') } }]);
  });

  test('keeps POSIX names and creates worktrees beside the project', () => {
    expect(folderName('con:tool\\name', 'linux')).toBe('con:tool\\name');
    expect(folderName('..', 'linux')).toBeUndefined();
    expect(folderName('a/b', 'linux')).toBe('a_b');
    expect(worktreePath('/home/me/my repo', 'fix', 'linux')).toBe('/home/me/my repo-worktrees/fix');
  });

  test.runIf(process.platform !== 'win32')('browses POSIX directories and follows directory symlinks without Win32 calls', async () => {
    const db = database();
    void db;
    const root = dirs.at(-1)!;
    mkdirSync(join(root, 'child'));
    symlinkSync(join(root, 'child'), join(root, 'link'), 'dir');
    expect((await listFolders(root, ['/'])).folders.map((folder) => folder.path)).toEqual([join(root, 'child'), join(root, 'link')]);
    expect(await localFolder(join(root, 'link'), ['/'])).toBe(join(root, 'child'));
    expect((await listFolders('/', ['/'])).parent).toBeNull();
  });
});

describe('Linux external process identity', () => {
  test('extracts starttime field 22 after the last parenthesis, without losing integer precision', () => {
    const stat = `42 (claude worker (v2)) S ${Array(18).fill('0').join(' ')} 9876543210987654321 0 0`;
    expect(parseLinuxStartTime(stat)).toBe('9876543210987654321');
    expect(parseLinuxStartTime('42 (bad) S 0')).toBeUndefined();
    expect(parseLinuxStartTime(stat.replace('9876543210987654321', 'bad'))).toBeUndefined();
  });

  const trusted = { executables: ['/opt/claude/bin/claude'], versionsDirectory: '/home/me/.local/share/claude/versions' };
  test('recognizes versioned native Claude and an exactly resolved PATH image, not namesakes', () => {
    expect(isLinuxClaudeProcess('/home/me/.local/share/claude/versions/2.1.61', [], trusted)).toBe(true);
    expect(isLinuxClaudeProcess('/opt/claude/bin/claude', [], trusted)).toBe(true);
    for (const image of ['/tmp/claude', '/tmp/2.1.61', '/home/me/.local/share/claude/versions/node', '/home/other/.local/share/claude/versions/2.1.61']) {
      expect(isLinuxClaudeProcess(image, ['claude'], trusted)).toBe(false);
    }
  });

  test('recognizes npm Claude only through the trusted CLI script in node argv[1]', () => {
    const script = '/opt/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    const paths = { ...trusted, executables: [script] };
    expect(isLinuxClaudeProcess('/usr/bin/node', ['node', script, '--resume', 'session'], paths)).toBe(true);
    expect(isLinuxClaudeProcess('/usr/bin/node', ['node', '/tmp/worker.js', script], paths)).toBe(false);
    expect(isLinuxClaudeProcess('/usr/bin/node', ['node', '-e', script], paths)).toBe(false);
    expect(isLinuxClaudeProcess('/usr/bin/python', ['python', script], paths)).toBe(false);
  });
});
