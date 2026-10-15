/**
 * Launch specs for the local shells Vesper hosts.
 *
 * Every shell is switched to UTF-8 at startup. ConPTY already turns the screen
 * into UTF-8 VT output, but native programs that write bytes (git, node, python)
 * follow the console code page, which is 936 on this machine.
 */

export type ShellKind = 'powershell' | 'cmd' | 'gitbash';

export interface ShellPaths {
  systemRoot: string;
  gitBash: string;
}

export interface LaunchSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
}

const POWERSHELL_BOOTSTRAP = [
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
].join('; ');

export function shellLaunchSpec(kind: ShellKind, paths: ShellPaths): LaunchSpec {
  switch (kind) {
    case 'powershell':
      return {
        file: `${paths.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        // -EncodedCommand passes the script on the command line, so no .ps1 file
        // is written and the execution policy does not apply. Profiles still load.
        args: ['-NoLogo', '-NoExit', '-EncodedCommand', encodePowerShellCommand(POWERSHELL_BOOTSTRAP)],
        env: {},
      };
    case 'cmd':
      return { file: `${paths.systemRoot}\\System32\\cmd.exe`, args: ['/K', 'chcp 65001>nul'], env: {} };
    case 'gitbash':
      return {
        file: paths.gitBash,
        args: ['-c', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i'],
        // Keeps the login profile from changing to the home directory.
        env: { CHERE_INVOKING: '1' },
      };
  }
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Merges environment variables the way Windows treats them: names are
 * case-insensitive, the first spelling seen is kept, and later values win.
 */
export function buildEnv(...sources: Record<string, string | undefined>[]): Record<string, string> {
  const names = new Map<string, string>();
  const env: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const key = name.toLowerCase();
      const spelling = names.get(key) ?? name;
      names.set(key, spelling);
      env[spelling] = value;
    }
  }
  return env;
}
