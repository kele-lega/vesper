import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseLaunchCommand, SHELL_KINDS, type CreateOptions, type Elevation, type ShellKind } from '@vesper/protocol';
import { log } from '@vesper/ptyd/client';
import { inTransaction } from './web-db.js';
import type { ImportedProfile } from './wt-import.js';
import { findExecutable, isExecutable, pathsFor } from './platform.js';

export type AgentKind = 'claude' | 'codex' | 'gemini';
/** A launch command as stored; its label is the profile name. */
export type StoredCommand = ({ file: string; args: string[] } | { commandLine: string }) & { env?: Record<string, string> };

/** What a new tab runs, and with which privilege (applied from M2b on). */
export interface NewProfile {
  name: string;
  launch: { shell: ShellKind } | { command: StoredCommand };
  agent: AgentKind | null;
  elevation: 'admin' | 'normal';
  source: 'builtin' | 'wt' | 'user';
  wtGuid: string | null;
}

export interface Profile extends NewProfile {
  id: string;
  position: number;
  createdAt: number;
}

interface Row extends Omit<Profile, 'launch'> {
  shell: string | null;
  command: string | null;
}

const SEEDED = 'profiles_seeded';
const COLUMNS = 'id, name, shell, command, agent, elevation, source, wt_guid AS wtGuid, position, created_at AS createdAt';

export interface DefaultsEnvironment {
  platform?: NodeJS.Platform;
  path?: string;
  shell?: string;
  executable?: (path: string) => boolean;
  /** %APPDATA%, where npm puts global CLIs on Windows. */
  appData: string;
  gitBash: string;
  exists: (path: string) => boolean;
}

/**
 * First-start profiles: Windows Terminal's, then the shells it lacks, then the agents
 * found installed. Agents and other commands default to normal privilege, shells to admin.
 */
export function defaultProfiles(imported: readonly ImportedProfile[], env: DefaultsEnvironment): NewProfile[] {
  if ((env.platform ?? process.platform) !== 'win32') return unixProfiles(env);
  const fromWt = imported.map((profile): NewProfile => {
    const isShell = 'shell' in profile.launch;
    const launch = 'shell' in profile.launch ? { shell: profile.launch.shell } : { command: { commandLine: profile.launch.commandLine } };
    return { name: profile.name, launch, agent: null, elevation: isShell ? 'admin' : 'normal', source: 'wt', wtGuid: profile.guid ?? null };
  });
  const builtin = (name: string, launch: NewProfile['launch'], agent: AgentKind | null): NewProfile => ({
    name,
    launch,
    agent,
    elevation: agent ? 'normal' : 'admin',
    source: 'builtin',
    wtGuid: null,
  });
  const has = new Set(fromWt.flatMap((profile) => ('shell' in profile.launch ? [profile.launch.shell] : [])));
  const extra: NewProfile[] = [];
  if (!has.has('powershell')) extra.push(builtin('Windows PowerShell', { shell: 'powershell' }, null));
  if (!has.has('cmd')) extra.push(builtin('命令提示符', { shell: 'cmd' }, null));
  if (!has.has('gitbash') && env.exists(env.gitBash)) extra.push(builtin('Git Bash', { shell: 'gitbash' }, null));
  const npm = `${env.appData}\\npm`;
  const claude = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  if (env.exists(claude)) extra.push(builtin('Claude Code', { command: { file: claude, args: [] } }, 'claude'));
  // npm's .cmd launchers set up the environment these CLIs expect; the full path keeps PATH out of it.
  for (const [name, agent] of [['Codex', 'codex'], ['Gemini', 'gemini']] as const) {
    const launcher = `${npm}\\${agent}.cmd`;
    if (env.exists(launcher)) extra.push(builtin(name, { command: { commandLine: `"${launcher}"` } }, agent));
  }
  // Keep the existing npm locations first, then include native/PATH installations.
  const path = env.path ?? process.env['PATH'] ?? process.env['Path'] ?? '';
  for (const [name, agent] of AGENTS) {
    if (extra.some((profile) => profile.agent === agent)) continue;
    const file = findExecutable(agent, path, 'win32', env.executable ?? env.exists);
    if (file) extra.push(builtin(name, { command: /\.(cmd|bat)$/i.test(file) ? { commandLine: `"${file}"` } : { file, args: [] } }, agent));
  }
  return [...fromWt, ...extra];
}

const AGENTS = [['Claude Code', 'claude'], ['Codex', 'codex'], ['Gemini', 'gemini']] as const;
const UNIX_SHELLS: [ShellKind, string][] = [['bash', 'Bash'], ['zsh', 'Zsh'], ['fish', 'Fish'], ['sh', 'sh']];

function unixProfiles(env: DefaultsEnvironment): NewProfile[] {
  const path = env.path ?? process.env['PATH'] ?? '/usr/bin:/bin';
  const executable = env.executable ?? isExecutable;
  const make = (name: string, launch: NewProfile['launch'], agent: AgentKind | null = null): NewProfile => ({ name, launch, agent, elevation: 'normal', source: 'builtin', wtGuid: null });
  const preferred = pathsFor('linux').basename(env.shell ?? '');
  const shells = [...UNIX_SHELLS].sort(([a], [b]) => Number(b === preferred) - Number(a === preferred));
  const profiles = shells.flatMap(([shell, name]) => {
    const file = findExecutable(shell, path, 'linux', executable) ?? [`/bin/${shell}`, `/usr/bin/${shell}`].find(executable);
    return file ? [make(name, { shell })] : [];
  });
  for (const [name, agent] of AGENTS) {
    const file = findExecutable(agent, path, 'linux', executable);
    if (file) profiles.push(make(name, { command: { file, args: [] } }, agent));
  }
  return profiles;
}

export class ProfileStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private normal<T extends Pick<NewProfile, 'elevation'>>(profile: T): T {
    return this.platform === 'win32' ? profile : { ...profile, elevation: 'normal' };
  }

  list(): Profile[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM profiles ORDER BY position, created_at`).all() as unknown as Row[];
    return rows.flatMap((row) => {
      const profile = toProfile(row);
      return profile ? [this.normal(profile)] : [];
    });
  }

  get(id: string): Profile | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`).get(id) as Row | undefined;
    const profile = row && toProfile(row);
    return profile && this.normal(profile);
  }

  /** Writes the first-start profiles unless that was done before; `build` runs only when needed. */
  seed(build: () => NewProfile[]): boolean {
    return inTransaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SEEDED)) return false;
      const insert = this.db.prepare(
        'INSERT INTO profiles (id, name, shell, command, agent, elevation, source, wt_guid, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      build().forEach((profile, position) => {
        const { shell, command } = columns(profile.launch);
        insert.run(randomBytes(12).toString('base64url'), profile.name, shell, command, profile.agent, this.normal(profile).elevation, profile.source, profile.wtGuid, position, this.now());
      });
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SEEDED, 'true');
      return true;
    });
  }

  /** Adds a profile at the end; `profile` must have passed parseProfileInput. */
  add(profile: NewProfile): Profile {
    const id = randomBytes(12).toString('base64url');
    const position = (this.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM profiles').get() as { next: number }).next;
    const { shell, command } = columns(profile.launch);
    this.db
      .prepare('INSERT INTO profiles (id, name, shell, command, agent, elevation, source, wt_guid, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, profile.name, shell, command, profile.agent, this.normal(profile).elevation, profile.source, profile.wtGuid, position, this.now());
    return this.get(id)!;
  }

  /** Replaces what a profile runs; its id, place and source stay. */
  update(id: string, profile: Pick<NewProfile, 'name' | 'launch' | 'agent' | 'elevation'>): Profile | undefined {
    const { shell, command } = columns(profile.launch);
    const { changes } = this.db
      .prepare('UPDATE profiles SET name = ?, shell = ?, command = ?, agent = ?, elevation = ? WHERE id = ?')
      .run(profile.name, shell, command, profile.agent, this.normal(profile).elevation, id);
    return changes > 0 ? this.get(id) : undefined;
  }

  /** Open tabs keep running; they just no longer name a profile. */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes > 0;
  }

  /** `ids` must be every profile exactly once. */
  reorder(ids: readonly string[]): boolean {
    const known = new Set(this.list().map((profile) => profile.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) return false;
    inTransaction(this.db, () => {
      const move = this.db.prepare('UPDATE profiles SET position = ? WHERE id = ?');
      ids.forEach((id, position) => move.run(position, id));
    });
    return true;
  }

  /** What ptyd needs to start this profile; undefined when it is missing or its command no longer validates. */
  createOptions(id: string): (CreateOptions & { elevation: Elevation }) | undefined {
    const profile = this.get(id);
    if (!profile) return undefined;
    const { elevation, agent } = profile;
    if ('shell' in profile.launch) return { shell: profile.launch.shell, elevation };
    try {
      const command = { ...profile.launch.command, label: profile.name, ...(agent ? { agent } : {}) };
      return { command: parseLaunchCommand(command), elevation };
    } catch (error) {
      log.warn(`profile ${id} has a command that cannot start`, error);
      return undefined;
    }
  }
}

function columns(launch: NewProfile['launch']): { shell: string | null; command: string | null } {
  return 'shell' in launch ? { shell: launch.shell, command: null } : { shell: null, command: JSON.stringify(launch.command) };
}

function toProfile(row: Row): Profile | undefined {
  const { shell, command, ...rest } = row;
  if (shell !== null) return SHELL_KINDS.includes(shell as ShellKind) ? { ...rest, launch: { shell: shell as ShellKind } } : undefined;
  try {
    return { ...rest, launch: { command: JSON.parse(command ?? '') as StoredCommand } };
  } catch {
    log.warn(`profile ${row.id} has an unreadable command`);
    return undefined;
  }
}
