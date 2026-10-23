/**
 * Launch specs for the local shells Vesper hosts.
 *
 * Every shell is switched to UTF-8 at startup. ConPTY already turns the screen
 * into UTF-8 VT output, but native programs that write bytes (git, node, python)
 * follow the console code page, which is 936 on this machine.
 */

import { win32 } from 'node:path';
import type { LaunchCommand, ShellKind, UNIX_SHELLS } from '@vesper/protocol';
import { unixShellLaunchSpec } from './unix-shells.js';

export type { ShellKind };

export interface ShellPaths {
  systemRoot: string;
  gitBash: string;
  unix?: Partial<Record<(typeof UNIX_SHELLS)[number], string>>;
}

export interface LaunchSpec {
  file: string;
  /** A string is passed to the process as the rest of its command line, unchanged (see commandLaunchSpec). */
  args: string[] | string;
  env: Record<string, string>;
  /** Where the process itself starts, when that differs from the session's directory. */
  cwd?: string;
}

/** vesper-launch reads the child's directory from here, then removes it from the child's environment. */
export const LAUNCH_CWD_ENV = 'VESPER_LAUNCH_CWD';

/**
 * Every shell reports its current directory before each prompt as
 * `OSC 7690 ; cwd ; <nonce> ; <path> BEL`, so tabs can show it and restarts begin
 * there. The nonce is new for each shell: any program's output can contain an OSC,
 * and only reports carrying the nonce come from the prompt hook. Restarting in a
 * directory chosen by arbitrary output would be unsafe (a \\server\share path
 * would leak the user's NTLM credentials).
 */
export const CWD_OSC = 7690;

export interface ShellOptions {
  /** Proves a directory report comes from this shell's prompt hook. Must be base64url. */
  cwdNonce: string;
  /** The environment the shell inherits; PROMPT and PROMPT_COMMAND are extended, not replaced. */
  inherited?: Record<string, string | undefined>;
  /** Private per-session directory for bash/zsh startup wrappers. */
  integrationDir?: string;
}

const CMD_DEFAULT_PROMPT = '$P$G';

function powershellBootstrap(nonce: string): string {
  return [
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    // Wraps whatever prompt the profile set. The original runs first so it still sees $? from the last command.
    '$global:__VesperPrompt = if (Test-Path Function:\\prompt) { $function:prompt } else { { "PS $($PWD.Path)> " } }',
    'function global:prompt { $text = & $global:__VesperPrompt; $here = $executionContext.SessionState.Path.CurrentLocation; ' +
      `if ($here.Provider.Name -eq "FileSystem") { [Console]::Write("$([char]27)]${CWD_OSC};cwd;${nonce};$($here.ProviderPath)$([char]7)") }; $text }`,
  ].join('; ');
}

export function shellLaunchSpec(kind: ShellKind, paths: ShellPaths, options: ShellOptions): LaunchSpec {
  const { cwdNonce: nonce, inherited = process.env } = options;
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error('the directory nonce must be base64url');
  switch (kind) {
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
      return unixShellLaunchSpec(kind, paths, options);
    case 'powershell':
      return {
        file: `${paths.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        // -EncodedCommand passes the script on the command line, so no .ps1 file
        // is written and the execution policy does not apply. Profiles still load.
        args: ['-NoLogo', '-NoExit', '-EncodedCommand', encodePowerShellCommand(powershellBootstrap(nonce))],
        env: {},
      };
    case 'cmd':
      return {
        file: `${paths.systemRoot}\\System32\\cmd.exe`,
        args: ['/K', 'chcp 65001>nul'],
        env: { PROMPT: `$e]${CWD_OSC};cwd;${nonce};$P$e\\${envValue(inherited, 'PROMPT') ?? CMD_DEFAULT_PROMPT}` },
      };
    case 'gitbash': {
      const existing = envValue(inherited, 'PROMPT_COMMAND');
      const report = `printf "\\033]${CWD_OSC};cwd;${nonce};%s\\007" "$PWD"`;
      return {
        file: paths.gitBash,
        args: ['-c', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i'],
        env: {
          // Keeps the login profile from changing to the home directory.
          CHERE_INVOKING: '1',
          PROMPT_COMMAND: existing ? `${report}; ${existing}` : report,
        },
      };
    }
  }
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Launch spec for a profile's command. The command line is built here rather than
 * by node-pty, whose quoting leaves arguments that already start and end with a
 * quote alone and so cannot pass them through intact.
 */
export function commandLaunchSpec(command: LaunchCommand, systemRoot: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  const env = command.env ?? {};
  if (platform !== 'win32') {
    return 'commandLine' in command
      ? { file: '/bin/sh', args: ['-c', command.commandLine], env }
      : { file: command.file, args: [...command.args], env };
  }
  if ('commandLine' in command) {
    // /d skips cmd's AutoRun; /s removes only the outer quotes, so the line keeps its own.
    return { file: `${systemRoot}\\System32\\cmd.exe`, args: `/d /s /c "${command.commandLine}"`, env };
  }
  // node-pty leaves the program path unquoted when the argument string is empty.
  const args = command.args.length === 0 ? [] : command.args.map(quoteArgument).join(' ');
  return { file: command.file, args, env };
}

/**
 * Runs `spec` through vesper-launch, which starts it with a normal-privilege token in the same
 * console. The launcher passes everything after its own name to CreateProcess unchanged.
 */
export function throughLauncher(spec: LaunchSpec, launcher: string, cwd: string): LaunchSpec {
  const rest = typeof spec.args === 'string' ? spec.args : spec.args.map(quoteArgument).join(' ');
  return {
    file: launcher,
    args: [quoteArgument(spec.file), rest].filter(Boolean).join(' '),
    // The elevated launcher starts in its own protected folder, so no DLL planted in the
    // session's (writable) directory can load into it; the child starts in `cwd`.
    cwd: win32.dirname(launcher),
    env: { ...spec.env, [LAUNCH_CWD_ENV]: cwd },
  };
}

/** Quotes one argument so CommandLineToArgvW and the MSVC runtime read it back unchanged. */
export function quoteArgument(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  // Backslashes are literal except before a quote: those are doubled, and the quote is escaped.
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Quotes one literal argument for /bin/sh (never expands $, backticks, or quotes). */
export function quotePosixArgument(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Unix names are case-sensitive, unlike Windows (PATH and Path may coexist). */
export function buildEnvFor(platform: NodeJS.Platform, ...sources: Record<string, string | undefined>[]): Record<string, string> {
  if (platform === 'win32') return buildEnv(...sources);
  return Object.fromEntries(sources.flatMap((source) => Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)));
}

/**
 * Merges environment variables the way Windows treats them: names are
 * case-insensitive, the first spelling seen is kept, and later values win.
 */
export function buildEnv(...sources: Record<string, string | undefined>[]): Record<string, string> {
  const names = new Map<string, string>();
  const env: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const key = name.toLowerCase();
      const spelling = names.get(key) ?? name;
      names.set(key, spelling);
      env[spelling] = value;
    }
  }
  return env;
}

/** Reads an environment variable the Windows way: the case of its name does not matter. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value !== undefined) return value;
  return undefined;
}

/** The Git for Windows install directory (where /usr and /etc live) for a bash.exe path. */
export function gitRootOf(bashPath: string): string {
  return bashPath.replace(/[\\/](usr[\\/])?bin[\\/]bash\.exe$/i, '');
}

/** Git Bash reports $PWD as an MSYS path such as /c/Users or /usr/bin; returns the Windows path. */
export function msysToWindowsPath(path: string, gitRoot: string, tempDir: string): string {
  const backslashed = (value: string) => value.replace(/\//g, '\\');
  if (/^[A-Za-z]:[\\/]/.test(path)) return backslashed(path);
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}:${backslashed(drive[2] ?? '/')}`;
  if (path.startsWith('//')) return backslashed(path);
  if (path === '/tmp' || path.startsWith('/tmp/')) return tempDir + backslashed(path.slice('/tmp'.length));
  if (path.startsWith('/')) return gitRoot + backslashed(path).replace(/\\$/, '');
  return path;
}
