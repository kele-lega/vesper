/** Pure Linux --user service plan. No shell, system service, or privilege elevation. */
import path, { posix, type PlatformPath } from 'node:path';
import { parseOrigin } from './deploy-plan.js';

export const UNIT_NAME = 'vesper.service';
const UNIT_HEADER = '# Written by vesper deploy (Linux user service).';
const CONTROLS = /[\u{0000}-\u{001f}\u{007f}-\u{009f}\u{2028}\u{2029}]/u;

export interface LinuxPlanInput {
  userHome: string;
  /** Already selected by ptyd's vesperHome(), including VESPER_HOME / XDG_DATA_HOME. */
  home: string;
  node: string;
  sourceRoot: string;
  env: NodeJS.ProcessEnv;
  dir?: string;
}

export interface LinuxDeployPlan {
  installDir: string;
  home: string;
  node: string;
  unitFile: string;
  logFile: string;
  path: string;
}

export function absolutePath(value: string, label: string, paths: PlatformPath = path): string {
  if (!value || !paths.isAbsolute(value) || CONTROLS.test(value) || value.trim() !== value || (paths.sep === '/' && value.includes('\\'))) {
    throw new Error(`${label} 必须是无控制字符的绝对路径：${JSON.stringify(value)}`);
  }
  if (value.split(/[\\/]/).some((part) => part === '.' || part === '..')) throw new Error(`${label} 不能包含 . 或 ..`);
  return paths.normalize(value).replace(/[\\/]$/, '') || paths.parse(value).root;
}

export function pathsOverlap(left: string, right: string, paths: PlatformPath = path): boolean {
  const contains = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}

export function buildLinuxPlan(input: LinuxPlanInput, paths: PlatformPath = path): LinuxDeployPlan {
  const userHome = absolutePath(input.userHome, '用户 home', paths);
  const home = absolutePath(input.home, 'VESPER_HOME', paths);
  const installDir = absolutePath(input.dir ?? paths.join(userHome, '.local', 'lib', 'vesper'), '安装目录', paths);
  const node = absolutePath(input.node, 'Node', paths);
  const source = absolutePath(input.sourceRoot, '源码目录', paths);
  const config = absolutePath(input.env['XDG_CONFIG_HOME'] || paths.join(userHome, '.config'), 'XDG_CONFIG_HOME', paths);
  const unitFile = paths.join(config, 'systemd', 'user', UNIT_NAME);
  for (const [label, directory] of [['安装目录', installDir], ['VESPER_HOME', home]] as const) {
    const relative = paths.relative(directory, userHome);
    const containsUserHome = relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
    if (directory === paths.parse(directory).root || containsUserHome) {
      throw new Error(`${label} 不能是文件系统根、用户 home 或其父目录`);
    }
  }
  for (const protectedPath of [home, source, node, unitFile]) {
    if (pathsOverlap(installDir, protectedPath, paths)) throw new Error(`安装目录必须与数据、源码、Node 和用户 unit 分离：${protectedPath}`);
  }
  if (pathsOverlap(home, source, paths) || pathsOverlap(home, unitFile, paths)) throw new Error('VESPER_HOME 必须与源码和用户 unit 分离');
  const savedPath = input.env['PATH'];
  if (CONTROLS.test(input.home) || (paths.sep === '/' && Buffer.byteLength(paths.join(home, 'run', 'ptyd.sock')) > 103)) {
    throw new Error('VESPER_HOME 过长，超出 ptyd Unix socket 路径限制；请使用较短的绝对路径');
  }
  if (!savedPath || CONTROLS.test(savedPath)) throw new Error('部署时 PATH 不能为空或包含控制字符');
  return { installDir, home, node, unitFile, logFile: paths.join(home, 'logs', 'web.log'), path: savedPath };
}

export function unitHeader(installDir: string): string {
  return `${UNIT_HEADER}\n# Vesper install: ${installDir}\n`;
}

/** systemd.syntax quoting; Environment expands % specifiers but does not expand $. */
function quote(value: string): string {
  if (CONTROLS.test(value)) throw new Error('systemd unit 值不能包含控制字符');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function linuxUnit(plan: LinuxDeployPlan, origins: readonly string[]): string {
  const env = {
    PATH: plan.path,
    VESPER_HOME: plan.home,
    VESPER_ORIGINS: origins.map(parseOrigin).join(','),
    VESPER_LOG_FILE: plan.logFile,
    VESPER_PORT: '7690',
  };
  // ':' disables ExecStart's $ substitution. '%' is escaped independently in every value.
  // WorkingDirectory is a literal path setting, NOT a list of shell-style quoted arguments.
  return [
    unitHeader(plan.installDir).trimEnd(),
    '[Unit]',
    'Description=Vesper browser terminal (user)',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${plan.installDir.replace(/%/g, '%%')}`,
    `ExecStart=:${quote(plan.node)} ${quote(posix.join(plan.installDir, 'node_modules', '@vesper', 'web', 'dist', 'main.js'))}`,
    ...Object.entries(env).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`),
    'UnsetEnvironment=NODE_OPTIONS NODE_PATH VESPER_UI_DIST',
    'UMask=0077',
    'Restart=on-failure',
    'RestartSec=3',
    // ptyd is deliberately independent: web restarts must not kill terminal sessions.
    'KillMode=process',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
