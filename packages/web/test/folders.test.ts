import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FolderError, listFolders, localDrives, localFolder, pickLocalDrives } from '../src/folders.js';

/** Directory symlinks need an elevated process or Developer Mode; junctions do not. */
function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-symlink-probe-'));
  try {
    symlinkSync(dir, join(dir, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pickLocalDrives', () => {
  test('keeps fixed and removable drives, never network, optical or missing ones', () => {
    // Drive types: 2 removable, 3 fixed, 4 network, 5 optical, 6 RAM disk.
    const types: Record<string, number> = { C: 3, D: 3, E: 2, F: 5, Z: 4, R: 6 };
    const mask = ['C', 'D', 'E', 'F', 'R', 'Z'].reduce((bits, letter) => bits | (1 << (letter.charCodeAt(0) - 65)), 0);
    expect(pickLocalDrives(mask, (root) => types[root[0]!] ?? 1)).toEqual(['C:\\', 'D:\\', 'E:\\', 'R:\\']);
  });
});

describe.runIf(process.platform === 'win32')('localDrives', () => {
  test('includes the system drive', () => {
    const system = `${(process.env['SystemDrive'] ?? 'C:').toUpperCase()}\\`;
    expect(localDrives()).toContain(system);
  });
});

describe('listFolders', () => {
  let root: string;
  let drives: string[];

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'vesper-folders-')));
    drives = [parse(root).root.toUpperCase()];
    for (const name of ['beta', 'Alpha', 'item10', 'item9', '中文', '代码']) mkdirSync(join(root, name));
    writeFileSync(join(root, 'file.txt'), 'not a folder');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('lists only folders, in natural order, with the parent', async () => {
    const listing = await listFolders(root, drives);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(join(root, '..'));
    expect(listing.folders.map((folder) => folder.name)).toEqual(['Alpha', 'beta', 'item9', 'item10', '代码', '中文']);
    expect(listing.folders[0]!.path).toBe(join(root, 'Alpha'));
    expect(listing.truncated).toBe(false);
  });

  test('a drive root has no parent; .. is resolved before anything is read', async () => {
    expect((await listFolders(drives[0]!, drives)).parent).toBeNull();
    expect((await listFolders(join(root, 'beta', '..', 'Alpha'), drives)).path).toBe(join(root, 'Alpha'));
  });

  test.runIf(process.platform === 'win32')('includes junctions to folders', async () => {
    symlinkSync(join(root, 'Alpha'), join(root, 'link'), 'junction');
    expect((await listFolders(root, drives)).folders.map((folder) => folder.name)).toContain('link');
  });

  test.runIf(process.platform === 'win32' && canSymlink())('never follows a chain of links that ends on a network share', async () => {
    // .invalid never resolves, so even a regression cannot reach a real server.
    symlinkSync('\\\\vesper-test.invalid\\share', join(root, 'unc'), 'dir');
    symlinkSync('unc', join(root, 'hop'), 'dir');
    symlinkSync(join(root, 'hop'), join(root, 'outer'), 'junction');
    symlinkSync('Alpha', join(root, 'local'), 'dir');
    const names = (await listFolders(root, drives)).folders.map((folder) => folder.name);
    expect(names).toContain('local');
    for (const name of ['unc', 'hop', 'outer']) {
      expect(names).not.toContain(name);
      expect(await localFolder(join(root, name), drives)).toBeUndefined();
      await expect(listFolders(join(root, name), drives)).rejects.toMatchObject({ code: 'bad_path' });
    }
    expect(await localFolder(join(root, 'local'), drives)).toBe(join(root, 'Alpha'));
  });

  test('bounds a huge listing', async () => {
    const listing = await listFolders(root, drives, 2);
    expect(listing.folders).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  test.each(['relative\\dir', '\\\\server\\share', '\\\\?\\C:\\', 'C:\\a\u{0}b', 'C:\\dir:stream', ''])('refuses %j', async (path) => {
    await expect(listFolders(path, drives, undefined, 'win32')).rejects.toMatchObject({ code: 'bad_path' });
  });

  test('refuses drives that are not local, and missing folders', async () => {
    await expect(listFolders('Q:\\', drives)).rejects.toBeInstanceOf(FolderError);
    await expect(listFolders(join(root, 'missing'), drives)).rejects.toMatchObject({ code: 'not_found' });
    await expect(listFolders(join(root, 'file.txt'), drives)).rejects.toMatchObject({ code: 'not_found' });
  });
});
