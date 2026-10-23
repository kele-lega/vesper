/**
 * The pure parts of `vesper deploy` (deploy.ts): what to copy, the hidden start script and the
 * logon task. Everything that ends up in a script or in XML is validated or escaped here.
 */
import { join, win32 } from 'node:path';

export const MARKER = 'vesper-install.json';
export const START_SCRIPT = 'start.vbs';
export const TASK_NAME = 'Vesper';
/** Workspace packages: only these files are copied, never src or tests. */
export const WORKSPACE_FILES: Record<string, string[]> = {
  '@vesper/protocol': ['package.json', 'dist'],
  '@vesper/ptyd': ['package.json', 'dist', 'launcher'],
  '@vesper/web': ['package.json', 'dist'],
  '@vesper/cli': ['package.json', 'dist'],
  // The UI is served as built files; its React and xterm dependencies are bundled into them.
  '@vesper/ui': ['package.json', 'dist'],
};
const ROOTS = ['@vesper/web', '@vesper/cli', '@vesper/ui'];
const NO_DEPENDENCIES = new Set(['@vesper/ui']);
/** An https origin with a plain host name and optional port: nothing that could break out of a script. */
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

export function parseOrigin(value: string): string {
  const origin = value.trim().replace(/\/$/, '');
  if (!ORIGIN.test(origin)) throw new Error(`公网地址要写成 https://域名[:端口]，例如 https://vesper.example.com：${value}`);
  const url = new URL(origin);
  const validLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  if (!url.hostname.split('.').every((label) => validLabel.test(label)) || (url.port !== '' && Number(url.port) === 0)) {
    throw new Error(`无效的公网 origin：${value}`);
  }
  return origin;
}

export interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Every package the runtime loads, from the hoisted node_modules under `root`. A dependency
 * nested inside its parent's own node_modules travels with the parent and is not looked up again.
 */
export function runtimePackages(root: string, read: (dir: string) => PackageManifest | undefined): string[] {
  const found = new Set<string>();
  // Optional dependencies are often one package per platform; those npm skipped are not missing.
  const queue: { name: string; optional: boolean }[] = ROOTS.map((name) => ({ name, optional: false }));
  while (queue.length > 0) {
    const { name, optional } = queue.shift()!;
    if (found.has(name)) continue;
    const manifest = read(join(root, 'node_modules', name));
    if (!manifest) {
      if (optional) continue;
      throw new Error(`缺少依赖 ${name}：请先运行 npm install`);
    }
    found.add(name);
    if (NO_DEPENDENCIES.has(name)) continue;
    const parent = join(root, 'node_modules', name);
    const next = [
      ...Object.keys(manifest.dependencies ?? {}).map((dependency) => ({ name: dependency, optional: false })),
      ...Object.keys(manifest.optionalDependencies ?? {}).map((dependency) => ({ name: dependency, optional: true })),
    ];
    for (const dependency of next) if (!read(join(parent, 'node_modules', dependency.name))) queue.push(dependency);
  }
  return [...found].sort();
}

export interface StartOptions {
  installDir: string;
  node: string;
  home: string;
  origins: readonly string[];
}

/** VBScript string literal: quotes are doubled; paths cannot hold quotes, origins were validated. */
const vbs = (text: string) => `"${text.replace(/"/g, '""')}"`;

/**
 * Starts vesper-web with no window; it starts vesper-ptyd, which inherits the hidden console.
 * The task inherits the user's environment (HKCU\Environment), which normal-privilege sessions
 * can write, so what would steer code loading in the elevated processes is reset first: NODE_*
 * (NODE_OPTIONS --require), every VESPER_* (VESPER_UI_DIST, VESPER_GIT_BASH), and the Windows
 * folder ptyd builds cmd, PowerShell, icacls and csc paths from, read back from HKLM. ws would
 * otherwise look for its optional native modules outside the install folder (C:\node_modules).
 */
export function startScript({ installDir, node, home, origins }: StartOptions): string {
  const main = win32.join(installDir, 'node_modules', '@vesper', 'web', 'dist', 'main.js');
  const command = `""${node}"" ""${main}""`;
  return [
    "' Written by vesper deploy; run at logon by the Vesper scheduled task.",
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("Process")',
    'Dim names()',
    'ReDim names(-1)',
    'For Each entry In env',
    '  name = UCase(Left(entry, InStr(2, entry, "=") - 1))',
    '  If Left(name, 5) = "NODE_" Or Left(name, 7) = "VESPER_" Then',
    '    ReDim Preserve names(UBound(names) + 1)',
    '    names(UBound(names)) = name',
    '  End If',
    'Next',
    'For Each name In names',
    '  env.Remove name',
    'Next',
    'windows = shell.RegRead("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRoot")',
    'env("SystemRoot") = windows',
    'env("windir") = windows',
    'env("ComSpec") = windows & "\\System32\\cmd.exe"',
    'env("WS_NO_BUFFER_UTIL") = "1"',
    'env("WS_NO_UTF_8_VALIDATE") = "1"',
    `env("VESPER_HOME") = ${vbs(home)}`,
    `env("VESPER_ORIGINS") = ${vbs(origins.join(','))}`,
    `env("VESPER_LOG_FILE") = ${vbs(win32.join(home, 'logs', 'web.log'))}`,
    `shell.CurrentDirectory = ${vbs(installDir)}`,
    `shell.Run "${command}", 0, False`,
    '',
  ].join('\r\n');
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * At the user's logon, elevated, on battery too, never stopped for running long. The task runs
 * wscript, which returns at once; vesper-web outlives it.
 */
export function taskXml(user: string, wscript: string, script: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Vesper: terminals and agents in the browser</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowHardTerminate>false</AllowHardTerminate>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(wscript)}</Command><Arguments>${xml(`//B //Nologo "${script}"`)}</Arguments></Exec></Actions>
</Task>
`;
}
