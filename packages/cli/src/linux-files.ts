/** Filesystem safety for a non-elevated Linux install. Never follow deployment/data/log symlinks. */
import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { MARKER } from './deploy-plan.js';
import { absolutePath, type LinuxDeployPlan, pathsOverlap, unitHeader } from './linux-deploy-plan.js';

export interface LinuxInstallMarker {
  kind: 'vesper-linux-user';
  version: 1;
  installDir: string;
  home: string;
  unitFile: string;
}

export function statIfPresent(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Sticky shared ancestors are safe only when their next component already exists and is trusted. */
export function assertSafePath(file: string, kind: 'directory' | 'file', requireParents = false): void {
  const uid = process.getuid?.();
  const absolute = resolve(file);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  const parents = components.reduce<string[]>((all, component) => [...all, join(all.at(-1) ?? root, component)], [root]);
  let sharedParent = false;
  for (const current of parents) {
    const stat = statIfPresent(current);
    const leaf = current === absolute;
    if (!stat) {
      if (sharedParent) throw new Error(`共享父目录下的路径必须预先存在并归当前用户所有：${current}`);
      if (requireParents && !leaf) throw new Error(`父目录在检查期间消失：${current}`);
      continue;
    }
    if (stat.isSymbolicLink() || (leaf && kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      throw new Error(`拒绝符号链接、硬链接或类型不符的路径：${current}`);
    }
    if (uid === undefined) continue; // Windows fixture tests; production dispatch only reaches this on Linux.
    const stickyRoot = !leaf && stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((leaf && stat.uid !== uid) || (!leaf && stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !stickyRoot)) {
      throw new Error(`路径必须归当前用户（父目录可归 root）且不能被其他用户写入：${current}`);
    }
    sharedParent = (stat.mode & 0o022) !== 0;
  }
}

export function validateLinuxFiles(plan: LinuxDeployPlan): void {
  assertSafePath(plan.installDir, 'directory');
  assertSafePath(plan.home, 'directory');
  assertSafePath(dirname(plan.unitFile), 'directory');
  assertSafePath(plan.unitFile, 'file');
  assertSafePath(join(plan.home, 'run'), 'directory');
  assertSafePath(join(plan.home, 'run', 'ptyd.json'), 'file');
  assertSafePath(dirname(plan.logFile), 'directory');
  for (const name of ['web.log', 'web.log.1', 'ptyd.log', 'ptyd.log.1']) assertSafePath(join(dirname(plan.logFile), name), 'file');
}

export function readLinuxMarker(dir: string): LinuxInstallMarker | undefined {
  const file = join(dir, MARKER);
  if (!statIfPresent(file)) return undefined;
  assertSafePath(file, 'file');
  if (lstatSync(file).size > 64 * 1024) throw new Error(`部署标记过大：${file}`);
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'vesper-linux-user' || !('version' in value) || value.version !== 1 ||
      !('installDir' in value) || value.installDir !== dir || !('home' in value) || typeof value.home !== 'string' ||
      !('unitFile' in value) || typeof value.unitFile !== 'string') {
    throw new Error(`不是有效的 Linux Vesper 部署标记：${file}`);
  }
  return { kind: 'vesper-linux-user', version: 1, installDir: dir, home: absolutePath(value.home, '部署记录 VESPER_HOME'), unitFile: absolutePath(value.unitFile, '部署记录 unit') };
}

export function assertOwnedUnit(plan: LinuxDeployPlan, marker: LinuxInstallMarker | undefined): boolean {
  if (!statIfPresent(plan.unitFile)) return false;
  if (!marker || !readFileSync(plan.unitFile, 'utf8').startsWith(unitHeader(plan.installDir))) {
    throw new Error(`用户 unit 已存在但不属于此安装，不会覆盖或禁用它：${plan.unitFile}`);
  }
  return true;
}

/** Check recorded paths too: changing VESPER_HOME must never let uninstall delete the old data. */
export function assertMarkerPaths(marker: LinuxInstallMarker | undefined, plan: LinuxDeployPlan, uninstall = false): void {
  if (!marker) return;
  if (marker.unitFile !== plan.unitFile) throw new Error(`XDG_CONFIG_HOME 与原部署不同，请使用原用户 unit 目录：${marker.unitFile}`);
  if (pathsOverlap(plan.installDir, marker.home)) throw new Error('安装目录与原会话数据目录重叠，不会删除');
  if (!uninstall && marker.home !== plan.home) throw new Error(`VESPER_HOME 与原部署不同（${marker.home}）；请先安全卸载旧部署`);
}
