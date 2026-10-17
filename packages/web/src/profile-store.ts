import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseLaunchCommand, SHELL_KINDS, type CreateOptions, type Elevation, type ShellKind } from '@vesper/protocol';
import { log } from '@vesper/ptyd/client';
import { inTransaction } from './web-db.js';
import type { ImportedProfile } from './wt-import.js';

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
  /** %APPDATA%, where npm puts global CLIs. */
  appData: string;
  gitBash: string;
  exists: (path: string) => boolean;
}

/**
 * First-start profiles: Windows Terminal's, then the shells it lacks, then the agents
 * found installed. Agents and other commands default to normal privilege, shells to admin.
 */
export function defaultProfiles(imported: readonly ImportedProfile[], env: DefaultsEnvironment): NewProfile[] {
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
  return [...fromWt, ...extra];
}

export class ProfileStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Profile[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM profiles ORDER BY position, created_at`).all() as unknown as Row[];
    return rows.flatMap((row) => {
      const profile = toProfile(row);
      return profile ? [profile] : [];
    });
  }

  get(id: string): Profile | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`).get(id) as Row | undefined;
    return row && toProfile(row);
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
        insert.run(randomBytes(12).toString('base64url'), profile.name, shell, command, profile.agent, profile.elevation, profile.source, profile.wtGuid, position, this.now());
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
      .run(id, profile.name, shell, command, profile.agent, profile.elevation, profile.source, profile.wtGuid, position, this.now());
    return this.get(id)!;
  }

  /** Replaces what a profile runs; its id, place and source stay. */
  update(id: string, profile: Pick<NewProfile, 'name' | 'launch' | 'agent' | 'elevation'>): Profile | undefined {
    const { shell, command } = columns(profile.launch);
    const { changes } = this.db
      .prepare('UPDATE profiles SET name = ?, shell = ?, command = ?, agent = ?, elevation = ? WHERE id = ?')
      .run(profile.name, shell, command, profile.agent, profile.elevation, id);
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
    const { elevation } = profile;
    if ('shell' in profile.launch) return { shell: profile.launch.shell, elevation };
    try {
      return { command: parseLaunchCommand({ ...profile.launch.command, label: profile.name }), elevation };
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
