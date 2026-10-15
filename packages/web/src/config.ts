import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vesperHome } from '@vesper/ptyd/client';

export interface WebConfig {
  home: string;
  port: number;
  bind: string;
  /** Origins allowed to open WebSockets: the local ones plus any public address in front of this server. */
  origins: string[];
  uiDist: string;
  /** Bearer token for the API and WebSockets until password login lands (M2). */
  token: string;
  /** Directory new sessions start in when the client does not choose one. */
  defaultCwd: string;
}

const DEFAULT_PORT = 7690;
const BIND = '127.0.0.1';
const PREFERRED_CWD = 'D:\\code\\work_space';
const TOKEN_FILE = ['web', 'token'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const home = vesperHome(env);
  const port = Number(env['VESPER_PORT'] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid VESPER_PORT ${env['VESPER_PORT']}`);
  const extra = (env['VESPER_ORIGINS'] ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    home,
    port,
    bind: BIND,
    origins: [...localOrigins(port), ...extra],
    uiDist: env['VESPER_UI_DIST'] ?? fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
    token: loadToken(join(home, ...TOKEN_FILE)),
    defaultCwd: env['VESPER_DEFAULT_CWD'] ?? (isDirectory(PREFERRED_CWD) ? PREFERRED_CWD : homedir()),
  };
}

export function localOrigins(port: number): string[] {
  return [`http://${BIND}:${port}`, `http://localhost:${port}`];
}

/** The token survives restarts, so open pages reconnect without a new link. */
function loadToken(path: string): string {
  try {
    const token = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(token)) return token;
  } catch {
    // first start
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, token);
  renameSync(`${path}.tmp`, path);
  return token;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
