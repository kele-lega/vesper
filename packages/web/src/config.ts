import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vesperHome } from '@vesper/ptyd/client';
import { webDatabasePath } from './web-db.js';
import { wtSettingsCandidates } from './wt-import.js';

export interface ProfileSources {
  /** Windows Terminal's settings.json, read once on first start for profile names and command lines. */
  wtSettings: string | undefined;
  /** %APPDATA%, where npm installs the agent CLIs. */
  appData: string;
  gitBash: string;
}

export interface WebConfig {
  home: string;
  port: number;
  bind: string;
  /** Origins allowed to make changes and open WebSockets: the local ones plus any public address in front of this server. */
  origins: string[];
  uiDist: string;
  database: string;
  /** Directory new projects are made in, and unsorted tabs start in. */
  defaultCwd: string;
  profileSources: ProfileSources;
}

const DEFAULT_PORT = 7690;
const BIND = '127.0.0.1';
const PREFERRED_CWD = 'D:\\code\\work_space';
const DEFAULT_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const home = vesperHome(env);
  const port = Number(env['VESPER_PORT'] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid VESPER_PORT ${env['VESPER_PORT']}`);
  const extra = (env['VESPER_ORIGINS'] ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const localAppData = env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  return {
    home,
    port,
    bind: BIND,
    origins: [...localOrigins(port), ...extra],
    uiDist: env['VESPER_UI_DIST'] ?? fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
    database: webDatabasePath(home),
    defaultCwd: env['VESPER_DEFAULT_CWD'] ?? (isDirectory(PREFERRED_CWD) ? PREFERRED_CWD : homedir()),
    profileSources: {
      // VESPER_WT_SETTINGS=none skips the import (tests use it).
      wtSettings: env['VESPER_WT_SETTINGS'] === 'none' ? undefined : (env['VESPER_WT_SETTINGS'] ?? wtSettingsCandidates(localAppData).find((path) => existsSync(path))),
      appData: env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'),
      gitBash: env['VESPER_GIT_BASH'] ?? DEFAULT_GIT_BASH,
    },
  };
}

export function localOrigins(port: number): string[] {
  return [`http://${BIND}:${port}`, `http://localhost:${port}`];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
