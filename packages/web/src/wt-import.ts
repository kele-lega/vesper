import { join } from 'node:path';
import { isRecord, parseLaunchCommand, type ShellKind } from '@vesper/protocol';
import { parse, type ParseError } from 'jsonc-parser';

/**
 * Profiles taken from Windows Terminal's settings.json on first start. Only each
 * profile's name, guid and command line are read; the files a command line names
 * (such as a launcher script) are never opened.
 */
export interface ImportedProfile {
  name: string;
  guid?: string;
  launch: { shell: ShellKind } | { commandLine: string };
}

const MAX_NAME = 256;
const MAX_GUID = 64;
/** A command line that is just one of these programs runs as that Vesper shell, with its prompt hooks. */
const PLAIN_SHELLS: Record<string, ShellKind> = { 'powershell.exe': 'powershell', powershell: 'powershell', 'cmd.exe': 'cmd', cmd: 'cmd' };

/** Where Windows Terminal keeps its settings: the Store and Preview packages, then the unpackaged build. */
export function wtSettingsCandidates(localAppData: string): string[] {
  return [
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
}

/** Visible profiles that have a command line; anything malformed is skipped, never thrown. */
export function parseWtProfiles(text: string): ImportedProfile[] {
  const errors: ParseError[] = [];
  const settings: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!isRecord(settings)) return [];
  const profiles = Array.isArray(settings.profiles) ? settings.profiles : isRecord(settings.profiles) ? settings.profiles.list : undefined;
  if (!Array.isArray(profiles)) return [];
  return profiles.flatMap((entry) => {
    const profile = importProfile(entry);
    return profile ? [profile] : [];
  });
}

function importProfile(entry: unknown): ImportedProfile | undefined {
  if (!isRecord(entry) || entry.hidden === true) return undefined;
  const { name, commandline, guid } = entry;
  if (typeof name !== 'string' || name.trim() === '' || typeof commandline !== 'string') return undefined;
  const label = boundedName(name.trim());
  const launch = classify(commandline.trim(), label);
  if (!launch) return undefined;
  return { name: label, ...(typeof guid === 'string' && guid.length <= MAX_GUID ? { guid } : {}), launch };
}

function classify(commandLine: string, label: string): ImportedProfile['launch'] | undefined {
  const program = /^"([^"]+)"$/.exec(commandLine)?.[1] ?? commandLine;
  const shell = /[\s"]/.test(program) ? undefined : PLAIN_SHELLS[(program.split(/[\\/]/).at(-1) ?? '').toLowerCase()];
  if (shell) return { shell };
  try {
    parseLaunchCommand({ commandLine, label });
    return { commandLine };
  } catch {
    return undefined; // too long, or holds line breaks or NUL
  }
}

/** Cuts a name to the label limit without splitting a surrogate pair. */
function boundedName(name: string): string {
  const cut = name.slice(0, MAX_NAME);
  return /[\u{d800}-\u{dbff}]$/u.test(cut) ? cut.slice(0, -1) : cut;
}
