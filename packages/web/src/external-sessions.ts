import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { findExecutable } from './platform.js';
import koffi from 'koffi';

/**
 * Claude Code sessions running outside Vesper (design.md §7.4). Claude writes `<pid>.json` into
 * its sessions folder while it runs; a record counts only when its process is still alive, is
 * the same process (the creation time matches, so a reused pid does not), and is Claude.
 */

const MAX_FILE_BYTES = 64 * 1024;
const RECORD_FILE = /^(\d{1,10})\.json$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_IMAGE_PATH = 32_767;
/** claude.exe, or the name Claude's updater gives the running binary it replaces (claude.exe.old.<n>). */
const CLAUDE_IMAGE = /^claude\.exe(\.old\.[^\\/]+)?$/i;

export interface ExternalClaude {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Claude's own word for it: idle, busy, or whatever a newer version reports. */
  status: string;
  name: string;
  startedAt: number;
  /** Internal process-identity token, used to recheck before terminating a Linux process. */
  procStart?: string;
}

/** OS start token (FILETIME on Windows, /proc starttime on Linux) and image identity. */
export interface ProcessFacts {
  start: string;
  name: string;
  /** On Linux only: full /proc identity matched a trusted Claude installation. */
  claude?: boolean;
}

export type ProcessLookup = (pids: readonly number[]) => Promise<ReadonlyMap<number, ProcessFacts>>;

// Anonymous struct: koffi type names are process-global and may only be registered once.
const FILETIME = koffi.struct({ dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' });
let api: ReturnType<typeof loadKernel32> | undefined;

function loadKernel32() {
  const lib = koffi.load('kernel32.dll');
  const time = koffi.out(koffi.pointer(FILETIME));
  return {
    OpenProcess: lib.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    GetProcessTimes: lib.func('GetProcessTimes', 'int', ['void *', time, time, time, time]),
    QueryFullProcessImageNameW: lib.func('int QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *size)'),
    CloseHandle: lib.func('int CloseHandle(void *handle)'),
  };
}

type FileTime = { dwLowDateTime: number; dwHighDateTime: number };

/** One process's start time and image name, or undefined when it is gone or cannot be opened. */
function processFacts(pid: number): ProcessFacts | undefined {
  api ??= loadKernel32();
  const handle: unknown = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return undefined;
  try {
    const created: FileTime = { dwLowDateTime: 0, dwHighDateTime: 0 };
    if (!api.GetProcessTimes(handle, created, {}, {}, {})) return undefined;
    const name = Buffer.alloc(MAX_IMAGE_PATH * 2);
    if (!api.QueryFullProcessImageNameW(handle, 0, name, [MAX_IMAGE_PATH])) return undefined;
    const path = name.toString('utf16le').split('\u{0}')[0] ?? '';
    const start = (BigInt(created.dwHighDateTime) << 32n) | BigInt(created.dwLowDateTime);
    return { start: start.toString(), name: win32.basename(path) };
  } finally {
    api.CloseHandle(handle);
  }
}

/**
 * The processes among `pids` that exist. Win32 calls rather than PowerShell: an elevated
 * PowerShell would autoload a module from the user's PSModulePath, which normal sessions can write.
 */
export const lookupProcesses: ProcessLookup = async (pids) => {
  if (process.platform === 'linux') return lookupLinuxProcesses(pids);
  const found = new Map<number, ProcessFacts>();
  if (process.platform !== 'win32') return found;
  for (const pid of pids) {
    const facts = processFacts(pid);
    if (facts) found.set(pid, facts);
  }
  return found;
};

export interface LinuxClaudePaths {
  /** Canonical real paths of Claude executables or npm CLI scripts found through PATH. */
  executables: readonly string[];
  versionsDirectory: string;
}

/** Field 22 follows comm, which can itself contain spaces and closing parentheses. */
export function parseLinuxStartTime(text: string): string | undefined {
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  const start = text.slice(close + 1).trim().split(/\s+/)[19];
  return start && /^\d+$/.test(start) ? start : undefined;
}

/** Never trust comm/argv[0] or just a basename: native releases are named after their version. */
export function isLinuxClaudeProcess(image: string, argv: readonly string[], trusted: LinuxClaudePaths): boolean {
  const executable = image.replace(/ \(deleted\)$/, '');
  const version = posix.basename(executable);
  if (posix.dirname(executable) === trusted.versionsDirectory && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return true;
  if (trusted.executables.includes(executable) && !/\.[cm]?js$/.test(executable)) return true;
  const script = argv[1];
  return /^node(?:js)?$/.test(posix.basename(executable)) && script !== undefined && posix.isAbsolute(script) &&
    /\/@anthropic-ai\/claude-code\/(?:bin\/)?cli\.[cm]?js$/.test(script) && trusted.executables.includes(script);
}

function linuxClaudePaths(): LinuxClaudePaths {
  const file = findExecutable('claude', process.env['PATH'] ?? '/usr/bin:/bin', 'linux');
  const executables: string[] = [];
  if (file) {
    try { executables.push(realpathSync(file)); } catch { /* disappeared during discovery */ }
  }
  const versions = join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'claude', 'versions');
  let versionsDirectory = versions;
  try { versionsDirectory = realpathSync(versions); } catch { /* no native installation */ }
  return { executables, versionsDirectory };
}

async function lookupLinuxProcesses(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessFacts>> {
  const found = new Map<number, ProcessFacts>();
  const trusted = linuxClaudePaths();
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      const root = `/proc/${pid}`;
      if (process.getuid && (await stat(root)).uid !== process.getuid()) continue;
      const before = parseLinuxStartTime(await readFile(`${root}/stat`, 'utf8'));
      const image = await readlink(`${root}/exe`);
      const argv = (await readFile(`${root}/cmdline`, 'utf8')).split('\u{0}');
      // npm's PATH entry may itself be a symlink to cli.js; compare canonical script identities.
      const script = argv[1];
      const command = script && posix.isAbsolute(script) && /^node(?:js)?$/.test(posix.basename(image))
        ? [argv[0] ?? '', await realpath(script)] : argv;
      const after = parseLinuxStartTime(await readFile(`${root}/stat`, 'utf8'));
      if (before && before === after) found.set(pid, { start: before, name: posix.basename(image), claude: isLinuxClaudeProcess(image, command, trusted) });
    } catch {
      // Gone, not owned by this user, or /proc is restricted: never offer it for takeover.
    }
  }
  return found;
}

interface RawRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  procStart: string;
  status: string;
  name: string;
  startedAt: number;
}

function readRecord(text: string): RawRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { pid, sessionId, cwd, procStart, status, name, startedAt, kind } = record;
  if (kind !== undefined && kind !== 'interactive') return undefined;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
  if (typeof cwd !== 'string' || typeof procStart !== 'string') return undefined;
  return {
    pid: pid as number,
    sessionId,
    cwd,
    procStart,
    status: typeof status === 'string' ? status : 'unknown',
    name: typeof name === 'string' ? name : '',
    startedAt: typeof startedAt === 'number' ? startedAt : 0,
  };
}

/** Claude's folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeSessionsDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'sessions');
}

/** The live, genuine Claude sessions in `dir`, oldest first. */
export async function listExternalClaude(dir: string, lookup: ProcessLookup = lookupProcesses): Promise<ExternalClaude[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: RawRecord[] = [];
  for (const file of names.filter((name) => RECORD_FILE.test(name))) {
    try {
      const text = await readFile(join(dir, file), 'utf8');
      if (text.length > MAX_FILE_BYTES) continue;
      const record = readRecord(text);
      if (record && `${record.pid}.json` === file) records.push(record);
    } catch {
      // gone or unreadable: not a session we can take over
    }
  }
  const alive = await lookup(records.map((record) => record.pid));
  return records
    .filter((record) => {
      const facts = alive.get(record.pid);
      return facts !== undefined && facts.start === record.procStart && (facts.claude ?? CLAUDE_IMAGE.test(facts.name));
    })
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ pid, sessionId, cwd, status, name, startedAt, procStart }) => ({ pid, sessionId, cwd, status, name, startedAt, ...(alive.get(pid)?.claude !== undefined ? { procStart } : {}) }));
}

/** Whether Claude has finished its turn: taking over mid-step would cut the step short. */
export function isIdle(session: Pick<ExternalClaude, 'status'>): boolean {
  return session.status === 'idle';
}

/** Ends a process and waits for it to go; false when it is still there after `timeoutMs`. */
export async function terminateAndWait(
  pid: number,
  options: { timeoutMs?: number; kill?: (pid: number) => void; alive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; expectedStart?: string; lookup?: ProcessLookup } = {},
): Promise<boolean> {
  const { timeoutMs = 5000, kill = (target: number) => process.kill(target), alive = processAlive, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options;
  if (options.expectedStart !== undefined) {
    const facts = (await (options.lookup ?? lookupProcesses)([pid])).get(pid);
    if (!facts || facts.start !== options.expectedStart || facts.claude !== true) return false;
  }
  kill(pid);
  const step = 100;
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    if (!alive(pid)) return true;
    await sleep(step);
  }
  return !alive(pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
