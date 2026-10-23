import type { ProfileDetail, ShellKind, WebSettings } from '@vesper/protocol';
import { useContext, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { FolderPicker } from './FolderPicker.js';
import { setSound, soundOn } from './notices.js';
import { navigate } from './router.js';
import { SecuritySettings } from './SecuritySettings.js';
import { ServerPlatform } from './platform.js';

const SKIP_FLAG = '--dangerously-skip-permissions';
const WINDOWS_SHELLS: [ShellKind, string][] = [['powershell', 'Windows PowerShell'], ['cmd', '命令提示符'], ['gitbash', 'Git Bash']];
const UNIX_SHELLS: [ShellKind, string][] = [['bash', 'Bash'], ['zsh', 'Zsh'], ['fish', 'Fish'], ['sh', 'sh']];
type Kind = 'shell' | 'file' | 'commandLine';

const message = (failure: unknown) => (failure instanceof ApiError ? failure.message : '保存失败');

export function Settings() {
  const windows = useContext(ServerPlatform) === 'win32';
  const [settings, setSettings] = useState<WebSettings>();
  const [profiles, setProfiles] = useState<ProfileDetail[]>([]);
  const [editing, setEditing] = useState<ProfileDetail | 'new'>();
  const [picking, setPicking] = useState(false);
  const [sound, setSoundState] = useState(soundOn);
  const [error, setError] = useState('');

  const load = () =>
    Promise.all([api<WebSettings>('GET', '/api/settings'), api<{ profiles: ProfileDetail[] }>('GET', '/api/profiles')]).then(
      ([next, list]) => {
        setSettings(next);
        setProfiles(list.profiles);
      },
      (failure: unknown) => setError(message(failure)),
    );
  useEffect(() => {
    document.title = '设置 · Vesper';
    void load();
  }, []);

  const run = (work: Promise<unknown>) => {
    setError('');
    void work.then(load, (failure: unknown) => setError(message(failure)));
  };
  const move = (index: number, by: number) => {
    const ids = profiles.map((profile) => profile.id!);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    run(api('PUT', '/api/profiles/order', { ids }));
  };

  return (
    <div className="page settings">
      <header className="topbar">
        <button type="button" onClick={() => navigate('/')}>
          ← 全部项目
        </button>
        <h1>设置</h1>
      </header>
      <main className="settings-body">
        <section>
          <h2>常规</h2>
          <label className="setting">
            <span>新项目的默认目录</span>
            <code>{settings?.defaultCwd ?? '…'}</code>
            <button type="button" onClick={() => setPicking(!picking)}>
              更改
            </button>
          </label>
          {picking && (
            <FolderPicker
              onPick={(path) => {
                setPicking(false);
                run(api('PATCH', '/api/settings', { defaultCwd: path }));
              }}
            />
          )}
          <label className="setting">
            <span>提醒提示音（这台设备）</span>
            <input
              type="checkbox"
              checked={sound}
              onChange={(event) => {
                setSound(event.target.checked);
                setSoundState(event.target.checked);
              }}
            />
          </label>
        </section>
        <section>
          <h2>Profile</h2>
          <ul className="profile-list">
            {profiles.map((profile, index) => (
              <li key={profile.id}>
                <span className="profile-name">{profile.name}</span>
                {windows && <span className="muted">{profile.elevation === 'admin' ? '管理员' : '普通权限'}</span>}
                <span className="spacer" />
                <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label="上移">↑</button>
                <button type="button" disabled={index === profiles.length - 1} onClick={() => move(index, 1)} aria-label="下移">↓</button>
                <button type="button" onClick={() => setEditing(profile)}>编辑</button>
                <button type="button" onClick={() => confirm(`删除 profile“${profile.name}”？已打开的标签不受影响。`) && run(api('DELETE', `/api/profiles/${profile.id}`))}>
                  删除
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setEditing('new')}>＋ 新建 profile</button>
        </section>
        <SecuritySettings />
        <p className="error" role="alert">{error}</p>
      </main>
      {editing && (
        <ProfileForm
          profile={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </div>
  );
}

function kindOf(launch: ProfileDetail['launch']): Kind {
  return 'shell' in launch ? 'shell' : 'file' in launch ? 'file' : 'commandLine';
}

/** Edits one profile; environment values already stored are kept unless typed again. */
export function ProfileForm({ profile, onClose, onSaved }: { profile: ProfileDetail | undefined; onClose: () => void; onSaved: () => void }) {
  const windows = useContext(ServerPlatform) === 'win32';
  const defaultShell: ShellKind = windows ? 'powershell' : 'bash';
  const launch = profile?.launch ?? { shell: defaultShell };
  const [name, setName] = useState(profile?.name ?? '');
  const [kind, setKind] = useState<Kind>(kindOf(launch));
  const [shell, setShell] = useState<ShellKind>('shell' in launch ? launch.shell : defaultShell);
  const [file, setFile] = useState('file' in launch ? launch.file : '');
  const [args, setArgs] = useState('file' in launch ? launch.args.join('\n') : '');
  const [line, setLine] = useState('commandLine' in launch ? launch.commandLine : '');
  const [env, setEnv] = useState<[string, string | null][]>(Object.entries(profile?.env ?? {}));
  const [elevation, setElevation] = useState<ProfileDetail['elevation']>(windows ? profile?.elevation ?? 'admin' : 'normal');
  const [agent, setAgent] = useState(profile?.agent ?? null);
  const [error, setError] = useState('');

  const argList = args.split('\n').map((entry) => entry.trim()).filter(Boolean);
  const skipping = kind === 'file' ? argList.includes(SKIP_FLAG) : line.includes(SKIP_FLAG);
  const toggleSkip = (on: boolean) => {
    if (kind === 'file') setArgs((on ? [...argList, SKIP_FLAG] : argList.filter((entry) => entry !== SKIP_FLAG)).join('\n'));
    else setLine(on ? `${line} ${SKIP_FLAG}`.trim() : line.replace(` ${SKIP_FLAG}`, '').replace(SKIP_FLAG, '').trim());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: ProfileDetail = {
      name,
      launch: kind === 'shell' ? { shell } : kind === 'file' ? { file, args: argList } : { commandLine: line },
      env: Object.fromEntries(env.filter(([key]) => key.trim() !== '')),
      agent,
      elevation: windows ? elevation : 'normal',
    };
    const saving = profile ? api('PATCH', `/api/profiles/${profile.id}`, body) : api('POST', '/api/profiles', body);
    void saving.then(onSaved, (failure: unknown) => setError(message(failure)));
  };

  return (
    <div className="dialog-backdrop">
      <form className="dialog profile-form" onSubmit={submit}>
        <h2>{profile ? `编辑“${profile.name}”` : '新建 profile'}</h2>
        <label>名字<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>
          类型
          <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
            <option value="shell">内置 shell</option>
            <option value="file">程序和参数</option>
            <option value="commandLine">命令行（经 {windows ? 'cmd.exe' : '/bin/sh'}）</option>
          </select>
        </label>
        {kind === 'shell' && (
          <label>
            Shell
            <select value={shell} onChange={(event) => setShell(event.target.value as ShellKind)}>
              {(windows ? WINDOWS_SHELLS : UNIX_SHELLS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
        {kind === 'file' && (
          <>
            <label>程序<input className="mono" value={file} onChange={(event) => setFile(event.target.value)} placeholder={windows ? 'C:\\path\\to\\program.exe' : '/usr/local/bin/program'} /></label>
            <label>参数（每行一个）<textarea className="mono" rows={3} value={args} onChange={(event) => setArgs(event.target.value)} /></label>
          </>
        )}
        {kind === 'commandLine' && <label>命令行<input className="mono" value={line} onChange={(event) => setLine(event.target.value)} /></label>}
        {kind !== 'shell' && (
          <fieldset>
            <legend>环境变量</legend>
            {env.map(([key, value], index) => (
              <div className="env-row" key={index}>
                <input className="mono" aria-label="变量名" value={key} onChange={(event) => setEnv(env.map((row, at) => (at === index ? [event.target.value, row[1]] : row)))} />
                <input
                  className="mono"
                  aria-label="值"
                  type="password"
                  value={value ?? ''}
                  placeholder={value === null ? '（已保存，不变）' : ''}
                  onChange={(event) => setEnv(env.map((row, at) => (at === index ? [row[0], event.target.value] : row)))}
                />
                <button type="button" aria-label="删除变量" onClick={() => setEnv(env.filter((_, at) => at !== index))}>×</button>
              </div>
            ))}
            <button type="button" onClick={() => setEnv([...env, ['', '']])}>＋ 变量</button>
          </fieldset>
        )}
        {windows && (
          <label>
            权限
            <select value={elevation} onChange={(event) => setElevation(event.target.value as ProfileDetail['elevation'])}>
              <option value="admin">管理员</option>
              <option value="normal">普通权限</option>
            </select>
          </label>
        )}
        <label>
          Agent
          <select value={agent ?? ''} onChange={(event) => setAgent((event.target.value || null) as ProfileDetail['agent'])}>
            <option value="">不是 agent</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        {agent === 'claude' && kind !== 'shell' && (
          <label className="setting">
            <span>跳过权限确认（{SKIP_FLAG}）</span>
            <input type="checkbox" checked={skipping} onChange={(event) => toggleSkip(event.target.checked)} />
          </label>
        )}
        <p className="error" role="alert">{error}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">保存</button>
        </div>
      </form>
    </div>
  );
}
