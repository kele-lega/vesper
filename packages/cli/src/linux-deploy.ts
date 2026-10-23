import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { vesperHome } from '@vesper/ptyd/client';
import type { DeployOptions } from './deploy.js';
import { MARKER } from './deploy-plan.js';
import { assertMarkerPaths, assertOwnedUnit, assertSafePath, readLinuxMarker, validateLinuxFiles, type LinuxInstallMarker } from './linux-files.js';
import { buildLinuxPlan, linuxUnit, UNIT_NAME, type LinuxDeployPlan } from './linux-deploy-plan.js';
import { linuxRuntimeRunning } from './linux-running.js';
import { copyRuntime, REPO_ROOT } from './runtime-copy.js';

export interface LinuxDependencies {
  userHome: string;
  home: string;
  node: string;
  sourceRoot: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  systemctl: (args: readonly string[]) => string;
  running: (home: string) => Promise<boolean>;
  copy: (dir: string) => string[];
}

function systemctl(args: readonly string[]): string {
  try {
    return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`systemctl --user 失败；确认已登录此普通用户且用户服务管理器可用。不会提权或操作系统服务。${message}`, { cause: error });
  }
}

function dependencies(): LinuxDependencies {
  return {
    userHome: homedir(), home: vesperHome(), node: process.execPath, sourceRoot: REPO_ROOT,
    env: process.env, uid: process.getuid!(), systemctl, running: linuxRuntimeRunning, copy: copyRuntime,
  };
}

function assertUser(deps: LinuxDependencies): void {
  if (deps.uid === 0) throw new Error('Linux 部署只支持普通用户；请勿使用 root 或 sudo。');
}

/** show succeeds for both active and inactive units; never mistake an unavailable user bus for stopped. */
async function refuseRunning(deps: LinuxDependencies, homes: readonly string[], checkUnit: boolean): Promise<void> {
  if (checkUnit) {
    const state = deps.systemctl(['show', UNIT_NAME, '--property=ActiveState', '--value']).trim();
    if (!['inactive', 'failed'].includes(state)) throw new Error(`Vesper 用户服务尚未停止（${state || '未知状态'}），拒绝安装/卸载。`);
  }
  for (const home of new Set(homes)) {
    if (await deps.running(home)) throw new Error('Vesper web/ptyd 正在运行，拒绝安装/卸载以免丢失会话；先停止 web，再确认可结束终端后运行 npm run stop-host。');
  }
}

function privateDirectory(dir: string): void {
  assertSafePath(dir, 'directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafePath(dir, 'directory', true);
  if (process.platform === 'linux') chmodSync(dir, 0o700);
}

function preparePlan(dir: string | undefined, deps: LinuxDependencies, uninstall = false): { plan: LinuxDeployPlan; marker: LinuxInstallMarker | undefined; ownedUnit: boolean } {
  assertUser(deps);
  const plan = buildLinuxPlan({ ...deps, dir });
  validateLinuxFiles(plan);
  const marker = readLinuxMarker(plan.installDir);
  assertMarkerPaths(marker, plan, uninstall);
  if (marker && marker.home !== plan.home) validateLinuxFiles({ ...plan, home: marker.home, logFile: join(marker.home, 'logs', 'web.log') });
  return { plan, marker, ownedUnit: assertOwnedUnit(plan, marker) };
}

function recheckPlan(plan: LinuxDeployPlan, expected: LinuxInstallMarker | undefined, uninstall = false): boolean {
  validateLinuxFiles(plan);
  const marker = readLinuxMarker(plan.installDir);
  assertMarkerPaths(marker, plan, uninstall);
  if (expected && (!marker || marker.home !== expected.home || marker.unitFile !== expected.unitFile)) {
    throw new Error('部署标记在检查期间发生变化，拒绝安装/卸载。');
  }
  if (marker && marker.home !== plan.home) validateLinuxFiles({ ...plan, home: marker.home, logFile: join(marker.home, 'logs', 'web.log') });
  if (!marker && existsSync(plan.installDir) && readdirSync(plan.installDir).length > 0) {
    throw new Error(`${plan.installDir} 已存在且不是 Vesper 部署的文件夹，不会覆盖它`);
  }
  return assertOwnedUnit(plan, marker);
}

function installRuntime(plan: LinuxDeployPlan, origins: readonly string[], deps: LinuxDependencies, expected: LinuxInstallMarker | undefined): number {
  recheckPlan(plan, expected);
  mkdirSync(dirname(plan.installDir), { recursive: true, mode: 0o700 });
  assertSafePath(plan.installDir, 'directory', true);
  const stage = mkdtempSync(join(dirname(plan.installDir), '.vesper-install-'));
  let installed = false;
  try {
    const packages = deps.copy(stage);
    const marker = { kind: 'vesper-linux-user', version: 1, installDir: plan.installDir, home: plan.home, unitFile: plan.unitFile, deployedAt: new Date().toISOString(), packages, origins };
    writeFileSync(join(stage, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    recheckPlan(plan, expected);
    assertSafePath(plan.installDir, 'directory', true);
    if (existsSync(plan.installDir)) rmSync(plan.installDir, { recursive: true });
    renameSync(stage, plan.installDir);
    installed = true;
    return packages.length;
  } finally {
    if (!installed) {
      assertSafePath(stage, 'directory', true);
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

export async function deployLinux(options: DeployOptions, deps = dependencies()): Promise<string> {
  const { plan, marker } = preparePlan(options.dir, deps);
  if (options.noTask) throw new Error('--no-task 仅用于 Windows；Linux 部署固定注册 systemd --user 服务。');
  const unit = linuxUnit(plan, options.origins); // validate before any writes
  if (!marker && existsSync(plan.installDir) && readdirSync(plan.installDir).length > 0) throw new Error(`${plan.installDir} 已存在且不是 Vesper 部署的文件夹，不会覆盖它`);
  // Probe user manager before copying. No start/stop, sudo, --system, or --now.
  deps.systemctl(['show-environment']);
  await refuseRunning(deps, [plan.home], true);
  const count = installRuntime(plan, options.origins, deps, marker);
  privateDirectory(plan.home);
  privateDirectory(join(plan.home, 'logs'));
  privateDirectory(dirname(plan.unitFile));
  writeFileSync(plan.unitFile, unit, { mode: 0o600 });
  deps.systemctl(['daemon-reload']);
  deps.systemctl(['enable', UNIT_NAME]);
  const lines = [`已复制 ${count} 个包到 ${plan.installDir}`, `已安装并 enable 用户服务 ${UNIT_NAME}；PATH 已保存；日志在 ${dirname(plan.logFile)}。`];
  if (options.start) {
    deps.systemctl(['start', UNIT_NAME]);
    lines.push('已请求启动：http://127.0.0.1:7690/（用 systemctl --user status vesper.service 检查）。');
  } else lines.push('尚未启动（仅显式 --start 才启动）；准备好后运行 systemctl --user start vesper.service。');
  return lines.join('\n');
}

export async function undeployLinux(dir?: string, deps = dependencies()): Promise<string> {
  const { plan, marker } = preparePlan(dir, deps, true);
  if (!marker) return `${plan.installDir} 不是 Vesper 部署的文件夹，没有删除`;
  deps.systemctl(['show-environment']);
  await refuseRunning(deps, [plan.home, marker.home], true);
  if (recheckPlan(plan, marker, true)) {
    deps.systemctl(['disable', UNIT_NAME]);
    recheckPlan(plan, marker, true);
    assertSafePath(plan.unitFile, 'file', true);
    rmSync(plan.unitFile);
    deps.systemctl(['daemon-reload']);
  }
  recheckPlan(plan, marker, true);
  assertSafePath(plan.installDir, 'directory', true);
  rmSync(plan.installDir, { recursive: true });
  return `已卸载 ${plan.installDir} 及其用户服务；会话和数据（${marker.home}）保留，未停止任何进程。`;
}
