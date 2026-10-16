import type { Dirent } from 'node:fs';
import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import koffi from 'koffi';

/**
 * The server-side folder picker for new projects: local drives and the folders
 * inside them, nothing else. Network drives and UNC paths are never touched, so
 * browsing cannot make this machine connect out (and send NTLM credentials).
 */

/** GetDriveTypeW results kept: removable, fixed, RAM disk. Network (4) and optical (5) are left out. */
const LOCAL_DRIVE_TYPES = new Set([2, 3, 6]);
const DRIVE_COUNT = 26;
const MAX_FOLDERS = 2000;
const MAX_PATH_LENGTH = 32_767;
const MAX_LINK_HOPS = 32;
const DRIVE_PATH = /^[A-Za-z]:\\/;
const CONTROL = /[\u{0}-\u{1f}]/u;
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const HAN_START = /^\p{Script=Han}/u;

export type FolderErrorCode = 'bad_path' | 'not_found' | 'denied';

export class FolderError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderListing {
  path: string;
  /** null at a drive root. */
  parent: string | null;
  folders: FolderEntry[];
  truncated: boolean;
}

/** Roots such as C:\ for every drive letter in `mask` whose type is local. */
export function pickLocalDrives(mask: number, driveType: (root: string) => number): string[] {
  const drives: string[] = [];
  for (let bit = 0; bit < DRIVE_COUNT; bit++) {
    if ((mask & (1 << bit)) === 0) continue;
    const root = `${String.fromCharCode(65 + bit)}:\\`;
    if (LOCAL_DRIVE_TYPES.has(driveType(root))) drives.push(root);
  }
  return drives;
}

let kernel32: { GetLogicalDrives: () => number; GetDriveTypeW: (root: string) => number } | undefined;

/** The local drives right now; both calls only read the drive table, so a dead network drive cannot stall them. */
export function localDrives(): string[] {
  if (!kernel32) {
    const lib = koffi.load('kernel32.dll');
    kernel32 = { GetLogicalDrives: lib.func('uint32_t GetLogicalDrives()'), GetDriveTypeW: lib.func('uint32_t GetDriveTypeW(const char16_t *root)') };
  }
  const api = kernel32;
  return pickLocalDrives(api.GetLogicalDrives(), (root) => api.GetDriveTypeW(root));
}

export async function listFolders(path: string, drives: readonly string[], limit = MAX_FOLDERS): Promise<FolderListing> {
  const resolved = checkedPath(path, drives);
  let entries: Dirent[];
  try {
    // Read the resolved folder, so readdir follows no link of its own.
    const real = await resolveLocally(resolved, drives);
    if (real === undefined) throw new FolderError('bad_path', 'this link leads off the local drives');
    entries = await readdir(real, { withFileTypes: true });
  } catch (error) {
    if (error instanceof FolderError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new FolderError('denied', 'no access to this folder');
    throw new FolderError('not_found', 'no such folder');
  }
  const folders: FolderEntry[] = [];
  for (const entry of entries) {
    const full = win32.join(resolved, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await localFolder(full, drives)))) folders.push({ name: entry.name, path: full });
  }
  folders.sort(byName);
  const root = resolved.slice(0, 3);
  return { path: resolved, parent: resolved === root ? null : win32.dirname(resolved), folders: folders.slice(0, limit), truncated: folders.length > limit };
}

/** As Explorer lists them: names starting with a Chinese character after the rest, pinyin order within each group. */
function byName(a: FolderEntry, b: FolderEntry): number {
  const han = Number(HAN_START.test(a.name)) - Number(HAN_START.test(b.name));
  return han !== 0 ? han : collator.compare(a.name, b.name);
}

/** A local drive path with no stream names or device prefixes, with `..` resolved, on one of `drives`. */
function checkedPath(path: string, drives: readonly string[]): string {
  if (path.length > MAX_PATH_LENGTH || !DRIVE_PATH.test(path) || CONTROL.test(path) || path.includes(':', 2)) {
    throw new FolderError('bad_path', 'not a local folder path');
  }
  const resolved = win32.resolve(path);
  if (!drives.includes(resolved.slice(0, 3).toUpperCase())) throw new FolderError('bad_path', 'not a local drive');
  return resolved;
}

/**
 * `path` with every junction and symlink resolved, or undefined if any hop leaves the local drives.
 * Uses only lstat and readlink, which never open a link's target: following a link to \\server\share,
 * even through a chain of local links, would connect to that server and send it this user's credentials.
 */
async function resolveLocally(path: string, drives: readonly string[]): Promise<string | undefined> {
  let current = path;
  for (let hops = 0; hops <= MAX_LINK_HOPS; ) {
    if (!DRIVE_PATH.test(current) || !drives.includes(current.slice(0, 3).toUpperCase())) return undefined;
    const parts = current.slice(3).split('\\').filter(Boolean);
    let prefix = current.slice(0, 3);
    let followed = false;
    for (const [index, part] of parts.entries()) {
      prefix = win32.join(prefix, part);
      if (!(await lstat(prefix)).isSymbolicLink()) continue;
      const target = win32.resolve(win32.dirname(prefix), await readlink(prefix));
      current = win32.join(target, ...parts.slice(index + 1));
      hops++;
      followed = true;
      break;
    }
    if (!followed) return current;
  }
  return undefined;
}

/** A local folder the server may open: on `drives`, and every link along the way stays local. */
export async function localFolder(path: string, drives: readonly string[]): Promise<string | undefined> {
  try {
    const real = await resolveLocally(checkedPath(path, drives), drives);
    return real !== undefined && (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}
