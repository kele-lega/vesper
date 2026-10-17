/**
 * vesper-launch.exe starts a program with a normal-privilege copy of the host's token (see
 * launcher/vesper-launch.cs). It is compiled on first use with the .NET Framework compiler that
 * ships with Windows, into a file named after the source's hash, so a changed source builds anew.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import { log } from './log.js';

const SOURCE = fileURLToPath(new URL('../launcher/vesper-launch.cs', import.meta.url));
const COMPILE_TIMEOUT_MS = 60_000;
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';

let elevated: boolean | undefined;

/** Whether this process holds an enabled Administrators group, so "normal" needs the launcher. */
export function hostIsElevated(): boolean {
  if (process.platform !== 'win32') return false;
  elevated ??= Boolean(koffi.load('shell32.dll').func('bool IsUserAnAdmin()')());
  return elevated;
}

/**
 * Closes Vesper's home to "normal" processes: only SYSTEM and Administrators keep access, and a
 * restricted token has Administrators deny-only. Otherwise such a process could read the host's
 * pipe token (and so ask for an admin shell), or replace the launcher an elevated host runs.
 * Children inherit the new entries, so files that already exist are covered too.
 */
export function protectHome(home: string, systemRoot: string): void {
  if (!hostIsElevated()) return;
  const icacls = join(systemRoot, 'System32', 'icacls.exe');
  execFileSync(icacls, [home, '/inheritance:r', '/grant:r', `*${SYSTEM_SID}:(OI)(CI)F`, `*${ADMINISTRATORS_SID}:(OI)(CI)F`, '/q'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

/** The compiled launcher in `binDir`, building it if this source has not been built yet. Throws if it cannot. */
export function compileLauncher(binDir: string, systemRoot: string): string {
  const source = readFileSync(SOURCE);
  const name = `vesper-launch-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const exe = join(binDir, `${name}.exe`);
  if (existsSync(exe)) return exe;
  mkdirSync(binDir, { recursive: true });
  // csc reads the copy in bin, so the bytes hashed are the bytes built, whatever happens to SOURCE meanwhile.
  const copy = join(binDir, `${name}.cs`);
  writeFileSync(copy, source);
  const csc = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const partial = `${exe}.${process.pid}.tmp`;
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${partial}`, copy], {
    cwd: binDir,
    timeout: COMPILE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  renameSync(partial, exe); // a half-written file is never taken for the launcher
  log.info(`built ${exe}`);
  return exe;
}

/**
 * What a host uses for "normal" sessions: the launcher when the host is elevated, undefined
 * when it is not (its own token is already normal). Built once, when first needed. With
 * `blocked` set (the home could not be protected, or there is no bin folder), an elevated
 * host refuses "normal" sessions instead of running them with its own token.
 */
export function launcherFor(binDir: string | undefined, systemRoot: string, blocked?: () => string | undefined): () => string | undefined {
  let built: string | undefined;
  return () => {
    if (!hostIsElevated()) return undefined;
    const reason = binDir === undefined ? 'this host has no folder to build vesper-launch in' : blocked?.();
    if (reason) throw new Error(`normal-privilege sessions are disabled: ${reason}`);
    built ??= compileLauncher(binDir!, systemRoot);
    return built;
  };
}
