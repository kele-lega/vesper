import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** %LOCALAPPDATA%\vesper unless VESPER_HOME says otherwise (tests and side-by-side installs). */
export function vesperHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['VESPER_HOME'] ?? join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'vesper');
}

export function hostPaths(home: string): HostPaths {
  // One pipe per home, so the name alone decides which host is the single instance.
  const hash = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
  return {
    home,
    dataDir: join(home, 'data'),
    runFile: join(home, 'run', 'ptyd.json'),
    logFile: join(home, 'logs', 'ptyd.log'),
    pipe: `\\\\.\\pipe\\vesper-ptyd-${hash}`,
  };
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
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(info));
  renameSync(temp, path);
}

/** Deletes the run file only if it still describes process `pid`. */
export function removeRunInfo(path: string, pid: number): void {
  if (readRunInfo(path)?.pid === pid) rmSync(path, { force: true });
}
