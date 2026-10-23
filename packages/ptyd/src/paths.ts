import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInteger, isRecord } from '@vesper/protocol';

/** Written by a ready ptyd; holds the secret every pipe client must present. */
export interface RunInfo {
  pid: number;
  pipe: string;
  token: string;
  protocol: number;
  startedAt: number;
}

export interface HostPaths {
  home: string;
  dataDir: string;
  runFile: string;
  logFile: string;
  pipe: string;
}

/** The ptyd entry script, for starting the host as its own process. */
export const PTYD_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));

/** Longest path a Unix socket address holds (sun_path is 108 bytes on Linux, 104 on macOS). */
const MAX_SOCKET_PATH = 103;

/**
 * VESPER_HOME, else %LOCALAPPDATA%\vesper on Windows and $XDG_DATA_HOME/vesper
 * (~/.local/share/vesper) elsewhere.
 */
export function vesperHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['VESPER_HOME']) return env['VESPER_HOME'];
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'vesper');
  return join(env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'vesper');
}

export function hostPaths(home: string, platform: NodeJS.Platform = process.platform): HostPaths {
  const runDir = join(home, 'run');
  let pipe: string;
  if (platform === 'win32') {
    // One pipe per home, so the name alone decides which host is the single instance.
    const hash = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
    pipe = `\\\\.\\pipe\\vesper-ptyd-${hash}`;
  } else {
    // Inside the home (mode 0700), so only this user can reach it.
    pipe = join(runDir, 'ptyd.sock');
    if (Buffer.byteLength(pipe) > MAX_SOCKET_PATH) throw new Error(`VESPER_HOME is too long for a Unix socket path: ${pipe}`);
  }
  return {
    home,
    dataDir: join(home, 'data'),
    runFile: join(runDir, 'ptyd.json'),
    logFile: join(home, 'logs', 'ptyd.log'),
    pipe,
  };
}

/** Protect existing directories as well as newly created ones before storing tokens or transcripts. */
export function prepareHome(home: string): void {
  if (!isAbsolute(home)) throw new Error('VESPER_HOME must be an absolute path');
  if (process.platform === 'win32') return;
  for (const path of [home, join(home, 'run'), join(home, 'data'), join(home, 'logs')]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid!()) throw new Error(`Vesper needs a directory owned by the current user: ${path}`);
    chmodSync(path, 0o700);
  }
}

export function readRunInfo(path: string): RunInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { pid, pipe, token, protocol, startedAt } = value;
  if (!isInteger(pid, 1, 0xffff_ffff) || typeof pipe !== 'string' || typeof token !== 'string') return undefined;
  if (!isInteger(protocol, 0, 0xffff_ffff) || !isInteger(startedAt, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  return { pid, pipe, token, protocol, startedAt };
}

export function writeRunInfo(path: string, info: RunInfo): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  // Holds the token: readable by this user only (Windows ignores the mode; the home's ACL covers it).
  writeFileSync(temp, JSON.stringify(info), { mode: 0o600 });
  renameSync(temp, path);
}

/** Deletes the run file only if it still describes process `pid`. */
export function removeRunInfo(path: string, pid: number): void {
  if (readRunInfo(path)?.pid === pid) rmSync(path, { force: true });
}
