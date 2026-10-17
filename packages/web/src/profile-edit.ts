import { isRecord, parseLaunchCommand, SHELL_KINDS, type ProfileDetail, type ShellKind } from '@vesper/protocol';
import type { NewProfile, Profile, StoredCommand } from './profile-store.js';

const MAX_NAME = 100;
const AGENTS = ['claude', 'codex', 'gemini'] as const;

export class ProfileInputError extends Error {}

/** What the settings page is shown: everything but environment values. */
export function toDetail(profile: Profile): ProfileDetail {
  const { launch } = profile;
  const env = 'command' in launch ? Object.fromEntries(Object.keys(launch.command.env ?? {}).map((name) => [name, null])) : {};
  const shown: ProfileDetail['launch'] =
    'shell' in launch ? { shell: launch.shell } : 'file' in launch.command ? { file: launch.command.file, args: launch.command.args } : { commandLine: launch.command.commandLine };
  return { id: profile.id, name: profile.name, launch: shown, env, agent: profile.agent, elevation: profile.elevation };
}

/**
 * Checks an edited profile and turns it into what is stored. A null environment value keeps the
 * one `before` has; names absent from the edit are dropped.
 */
export function fromDetail(input: unknown, before?: Profile): Pick<NewProfile, 'name' | 'launch' | 'agent' | 'elevation'> {
  if (!isRecord(input)) throw new ProfileInputError('expected a profile object');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > MAX_NAME) throw new ProfileInputError(`名字需要 1 到 ${MAX_NAME} 个字符`);
  const agent = input.agent === null || input.agent === undefined ? null : AGENTS.find((entry) => entry === input.agent);
  if (agent === undefined) throw new ProfileInputError('unknown agent');
  if (input.elevation !== 'admin' && input.elevation !== 'normal') throw new ProfileInputError('elevation must be admin or normal');
  const launch = isRecord(input.launch) ? input.launch : {};
  if (typeof launch.shell === 'string') {
    if (!SHELL_KINDS.includes(launch.shell as ShellKind)) throw new ProfileInputError('unknown shell');
    return { name, launch: { shell: launch.shell as ShellKind }, agent, elevation: input.elevation };
  }
  const env = mergeEnv(input.env, before);
  const program: StoredCommand =
    typeof launch.commandLine === 'string'
      ? { commandLine: launch.commandLine }
      : { file: typeof launch.file === 'string' ? launch.file : '', args: Array.isArray(launch.args) ? (launch.args as unknown[]).map(String) : [] };
  const command = { ...program, ...(Object.keys(env).length > 0 ? { env } : {}) };
  try {
    parseLaunchCommand({ ...command, label: name });
  } catch (error) {
    throw new ProfileInputError((error as Error).message);
  }
  return { name, launch: { command }, agent, elevation: input.elevation };
}

function mergeEnv(value: unknown, before?: Profile): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ProfileInputError('env must be an object');
  const stored = before && 'command' in before.launch ? (before.launch.command.env ?? {}) : {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      const kept = stored[key];
      if (kept === undefined) throw new ProfileInputError(`${key} has no stored value to keep`);
      env[key] = kept;
    } else if (typeof entry === 'string') env[key] = entry;
    else throw new ProfileInputError(`${key} must be text`);
  }
  return env;
}
