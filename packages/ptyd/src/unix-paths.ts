import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { UNIX_SHELLS } from '@vesper/protocol';
import type { ShellPaths } from './shells.js';

type UnixShell = (typeof UNIX_SHELLS)[number];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve once at host startup. Only absolute PATH entries can supply executable candidates. */
export function unixShellPaths(env: NodeJS.ProcessEnv): NonNullable<ShellPaths['unix']> {
  let listed: string[] = [];
  try {
    listed = readFileSync('/etc/shells', 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('/'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const dirs = (env['PATH'] ?? '').split(':').filter(isAbsolute);
  return Object.fromEntries(UNIX_SHELLS.flatMap((kind: UnixShell) => {
    const candidates = [...dirs.map((dir) => join(dir, kind)), ...listed.filter((path) => basename(path) === kind), `/bin/${kind}`, `/usr/bin/${kind}`];
    const file = candidates.find(executable);
    return file ? [[kind, file]] : [];
  }));
}
