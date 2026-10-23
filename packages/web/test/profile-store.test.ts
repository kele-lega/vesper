import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defaultProfiles, ProfileStore, type NewProfile } from '../src/profile-store.js';
import { openWebDatabase } from '../src/web-db.js';

const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
const CLAUDE = `${APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('defaultProfiles', () => {
  const imported = [
    { name: 'Windows PowerShell', guid: '{61c5}', launch: { shell: 'powershell' as const } },
    { name: '命令提示符', launch: { shell: 'cmd' as const } },
    { name: 'ccswitch-codex-fanren-grok', guid: '{1111}', launch: { commandLine: 'powershell.exe -File C:\\s\\ccswitch.ps1 codex' } },
  ];

  test('Windows Terminal profiles first, then Git Bash and the agents that are installed', () => {
    const present = new Set([CLAUDE, GIT_BASH, `${APPDATA}\\npm\\codex.cmd`]);
    const profiles = defaultProfiles(imported, { platform: 'win32', path: '', appData: APPDATA, gitBash: GIT_BASH, exists: (path) => present.has(path) });
    expect(profiles).toEqual<NewProfile[]>([
      { name: 'Windows PowerShell', launch: { shell: 'powershell' }, agent: null, elevation: 'admin', source: 'wt', wtGuid: '{61c5}' },
      { name: '命令提示符', launch: { shell: 'cmd' }, agent: null, elevation: 'admin', source: 'wt', wtGuid: null },
      {
        name: 'ccswitch-codex-fanren-grok',
        launch: { command: { commandLine: 'powershell.exe -File C:\\s\\ccswitch.ps1 codex' } },
        agent: null,
        elevation: 'normal',
        source: 'wt',
        wtGuid: '{1111}',
      },
      { name: 'Git Bash', launch: { shell: 'gitbash' }, agent: null, elevation: 'admin', source: 'builtin', wtGuid: null },
      { name: 'Claude Code', launch: { command: { file: CLAUDE, args: [] } }, agent: 'claude', elevation: 'normal', source: 'builtin', wtGuid: null },
      { name: 'Codex', launch: { command: { commandLine: `"${APPDATA}\\npm\\codex.cmd"` } }, agent: 'codex', elevation: 'normal', source: 'builtin', wtGuid: null },
    ]);
  });

  test('without Windows Terminal, the built-in shells stand in', () => {
    const names = defaultProfiles([], { platform: 'win32', path: '', appData: APPDATA, gitBash: GIT_BASH, exists: () => false }).map((profile) => profile.name);
    expect(names).toEqual(['Windows PowerShell', '命令提示符']);
  });
});

describe('ProfileStore', () => {
  let dir: string;
  let db: DatabaseSync;
  let store: ProfileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-profiles-'));
    db = openWebDatabase(join(dir, 'vesper.db'));
    store = new ProfileStore(db, () => 7, 'win32');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedOnce = (profiles: NewProfile[]) => store.seed(() => profiles);
  const claude: NewProfile = { name: 'Claude Code', launch: { command: { file: CLAUDE, args: ['--verbose'], env: { A: '1' } } }, agent: 'claude', elevation: 'normal', source: 'builtin', wtGuid: null };
  const shell: NewProfile = { name: 'cmd', launch: { shell: 'cmd' }, agent: null, elevation: 'admin', source: 'wt', wtGuid: null };

  test('seeds the defaults once, in order, and never again', () => {
    expect(seedOnce([shell, claude])).toBe(true);
    expect(seedOnce([shell])).toBe(false);
    const list = store.list();
    expect(list.map((profile) => profile.name)).toEqual(['cmd', 'Claude Code']);
    expect(list[1]).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), ...claude, position: 1, createdAt: 7 });
  });

  test('turns a profile into ptyd create options', () => {
    seedOnce([shell, claude]);
    const [cmd, agent] = store.list();
    expect(store.createOptions(cmd!.id)).toEqual({ shell: 'cmd', elevation: 'admin' });
    expect(store.createOptions(agent!.id)).toEqual({
      command: { file: CLAUDE, args: ['--verbose'], env: { A: '1' }, label: 'Claude Code', agent: 'claude' },
      elevation: 'normal',
    });
    expect(store.createOptions('missing')).toBeUndefined();
  });

  test('a stored command that no longer validates is not launched', () => {
    seedOnce([claude]);
    db.prepare('UPDATE profiles SET command = ?').run(JSON.stringify({ file: 'relative.exe', args: [] }));
    expect(store.createOptions(store.list()[0]!.id)).toBeUndefined();
  });
});
