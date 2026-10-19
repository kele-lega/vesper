/**
 * `vesper deploy`: copies the built runtime into a folder only administrators can change (so a
 * "normal" session cannot alter what later runs elevated), and registers a logon task that starts
 * it hidden. `vesper undeploy` removes both. Run from an elevated terminal after `npm run build`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostIsElevated, hostPaths, readRunInfo, vesperHome } from '@vesper/ptyd/client';
import { MARKER, parseOrigin, runtimePackages, START_SCRIPT, startScript, TASK_NAME, taskXml, WORKSPACE_FILES, type PackageManifest } from './deploy-plan.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB_PORT = 7690;

export interface DeployOptions {
  origins: string[];
  dir?: string;
  /** Copy only: no logon task (for trying the copy out). */
  noTask: boolean;
  start: boolean;
}

export function parseDeployArgs(args: string[]): DeployOptions {
  const options: DeployOptions = { origins: [], noTask: false, start: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--origin') options.origins.push(parseOrigin(args[++index] ?? ''));
    else if (arg === '--dir') options.dir = args[++index];
    else if (arg === '--no-task') options.noTask = true;
    else if (arg === '--start') options.start = true;
    else throw new Error(`不认识的参数 ${arg}`);
  }
  return options;
}

const system32 = (file: string) => win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', file);
const defaultDir = () => win32.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Vesper');

function readManifest(dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Files of a running Vesper are in use, and replacing them under it would mix versions. */
async function refuseIfRunning(): Promise<void> {
  const run = readRunInfo(hostPaths(vesperHome()).runFile);
  let hostAlive = false;
  if (run) {
    try {
      process.kill(run.pid, 0);
      hostAlive = true;
    } catch (error) {
      hostAlive = (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  if (hostAlive || (await portAnswers(WEB_PORT))) {
    throw new Error('Vesper 正在运行：先关掉 vesper-web（npm run demo 的窗口，或结束已部署的 node 进程），再运行 npm run stop-host，然后重试。');
  }
}

/** An existing folder is replaced only when it is empty or a previous deploy made it. */
function clearTarget(dir: string): void {
  if (!existsSync(dir)) return;
  if (readdirSync(dir).length > 0 && !existsSync(join(dir, MARKER))) throw new Error(`${dir} 已存在且不是 Vesper 部署的文件夹，不会覆盖它`);
  rmSync(dir, { recursive: true, force: true });
}

/** SYSTEM and Administrators change it, users only read and run it; owned by Administrators. */
function protect(dir: string): void {
  const icacls = system32('icacls.exe');
  execFileSync(icacls, [dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX', '/q'], { stdio: 'ignore', windowsHide: true });
  execFileSync(icacls, [dir, '/setowner', '*S-1-5-32-544', '/t', '/c', '/q'], { stdio: 'ignore', windowsHide: true });
}

export function copyRuntime(dir: string): string[] {
  const packages = runtimePackages(REPO_ROOT, readManifest);
  for (const name of packages) {
    const source = realpathSync(join(REPO_ROOT, 'node_modules', name));
    const target = join(dir, 'node_modules', name);
    const files = WORKSPACE_FILES[name];
    if (!files) {
      cpSync(source, target, { recursive: true, dereference: true });
      continue;
    }
    for (const file of files) {
      if (!existsSync(join(source, file))) throw new Error(`${name} 缺少 ${file}：请先运行 npm run build`);
      cpSync(join(source, file), join(target, file), { recursive: true, dereference: true, filter: (path) => !path.endsWith('.tsbuildinfo') });
    }
  }
  return packages;
}

function registerTask(script: string): void {
  const user = `${process.env['USERDOMAIN'] ?? '.'}\\${process.env['USERNAME'] ?? ''}`;
  const file = join(tmpdir(), `vesper-task-${process.pid}.xml`);
  // schtasks reads the declared UTF-16 reliably; a BOM marks it.
  writeFileSync(file, `\u{feff}${taskXml(user, system32('wscript.exe'), script)}`, 'utf16le');
  try {
    execFileSync(system32('schtasks.exe'), ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], { stdio: 'pipe', windowsHide: true });
  } finally {
    rmSync(file, { force: true });
  }
}

export async function deploy(options: DeployOptions): Promise<string> {
  if (!hostIsElevated()) throw new Error('请在“以管理员身份运行”的终端里运行：安装目录和计划任务需要管理员权限。');
  await refuseIfRunning();
  const dir = options.dir ?? defaultDir();
  clearTarget(dir);
  mkdirSync(dir, { recursive: true });
  protect(dir); // before copying, so every file inherits it
  const packages = copyRuntime(dir);
  const home = vesperHome();
  const script = win32.join(dir, START_SCRIPT);
  writeFileSync(script, startScript({ installDir: dir, node: process.execPath, home, origins: options.origins }));
  writeFileSync(join(dir, MARKER), `${JSON.stringify({ deployedAt: new Date().toISOString(), packages, origins: options.origins }, null, 2)}\n`);
  protect(dir); // owner of the files written above
  const lines = [`已复制 ${packages.length} 个包到 ${dir}`];
  if (!process.execPath.toLowerCase().startsWith((process.env['ProgramFiles'] ?? 'C:\\Program Files').toLowerCase())) {
    lines.push(`注意：node.exe 在 ${process.execPath}，不在受保护的目录里；普通权限的程序可能替换它。`);
  }
  if (options.noTask) return [...lines, '没有注册计划任务（--no-task）。'].join('\n');
  registerTask(script);
  lines.push(`已注册计划任务“${TASK_NAME}”：登录 Windows 时以管理员身份在后台启动；日志在 ${win32.join(home, 'logs')}。`);
  if (options.start) {
    execFileSync(system32('schtasks.exe'), ['/Run', '/TN', TASK_NAME], { stdio: 'pipe', windowsHide: true });
    lines.push(`已启动：http://127.0.0.1:${WEB_PORT}/`);
  }
  return lines.join('\n');
}

export async function undeploy(dir = defaultDir()): Promise<string> {
  if (!hostIsElevated()) throw new Error('请在“以管理员身份运行”的终端里运行。');
  await refuseIfRunning();
  const lines: string[] = [];
  try {
    execFileSync(system32('schtasks.exe'), ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'pipe', windowsHide: true });
    lines.push(`已删除计划任务“${TASK_NAME}”`);
  } catch {
    lines.push('没有找到计划任务');
  }
  if (existsSync(join(dir, MARKER))) {
    rmSync(dir, { recursive: true, force: true });
    lines.push(`已删除 ${dir}；会话数据（${vesperHome()}）保留`);
  } else lines.push(`${dir} 不是 Vesper 部署的文件夹，没有删除`);
  return lines.join('\n');
}
