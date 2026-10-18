/**
 * JSON messages on the vesper-ptyd named pipe (framing in pipe.ts).
 *
 * Every connection opens with a mutual-authentication handshake:
 *   client -> host   Hello      (role, client nonce; no token)
 *   host -> client   Challenge  (host's proof over the client nonce, host nonce) or a refusing HelloReply
 *   client -> host   Proof      (client's proof over the host nonce)
 *   host -> client   HelloReply
 * Proofs are HMACs keyed with the run-file token (ptyd/src/handshake.ts), so
 * neither side reveals the token and a process squatting the pipe name cannot
 * pass as the host. role 'control' then carries requests, responses and events;
 * role 'attach' streams one session as binary frames.
 */

export const HOST_PROTOCOL_VERSION = 5;
export const SHELL_KINDS = ['powershell', 'cmd', 'gitbash'] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_DIMENSION = 10_000;
const HANDSHAKE_VALUE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_PATH = 32_767;
const MAX_TITLE = 256;
const MAX_U32 = 0xffff_ffff;
/** CreateProcess's limit on a whole command line, and cmd.exe's on the line it runs. */
const MAX_COMMAND_LINE = 32_767;
const MAX_CMD_LINE = 8191;
const MAX_ARGS = 256;
const MAX_ENV = 100;
const MAX_ENV_NAME = 255;
/** A program on a local drive; UNC paths would make the host connect out (and send NTLM credentials). */
const LOCAL_ABSOLUTE = /^[A-Za-z]:\\/;
/** Windows variable names may hold most characters (ProgramFiles(x86)); never '=' or control characters. */
const ENV_NAME = /^[A-Za-z_(){}.\-+][A-Za-z0-9_(){}.\-+]*$/;

export interface TerminalSize { cols: number; rows: number }
export interface ResumePoint { inc: number; seq: number }

export type Hello =
  | { v: number; nonce: string; role: 'control' }
  | { v: number; nonce: string; role: 'attach'; session: string; resume?: ResumePoint; size?: TerminalSize };

export interface Challenge { proof: string; nonce: string }
export interface Proof { proof: string }

export type HostErrorCode =
  | 'bad_request' | 'unauthorized' | 'version_mismatch' | 'not_found' | 'bad_cwd' | 'spawn_failed' | 'internal';

export type HelloReply = { ok: true; v: number; pid: number } | { ok: false; error: HostErrorCode; message: string };

export interface SessionInfo {
  id: string;
  /** null for a session running a launch command instead of a shell. */
  shell: ShellKind | null;
  title: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  inc: number;
  cols: number;
  rows: number;
  createdAt: number;
  attached: number;
  /** What the session's program actually runs with. */
  elevation: Elevation;
  /** For an agent CLI: what it is doing. */
  agent: AgentInfo | null;
}

/**
 * A program a profile starts instead of a shell: either an executable with its
 * arguments, or a command line that cmd.exe runs (`cmd.exe /d /s /c "<line>"`).
 * Restarts run the same command again; env is added to the host's environment.
 */
export type LaunchCommand = { label: string; env?: Record<string, string>; agent?: AgentKind } & (
  | { file: string; args: string[] }
  | { commandLine: string }
);

/** Agent CLIs the host injects hooks into and follows; see design.md §7. */
export const AGENT_KINDS = ['claude', 'codex', 'gemini'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** idle: waiting for a prompt. working. waiting: needs the user (approval, a question). done: finished a turn. */
export type AgentState = 'idle' | 'working' | 'waiting' | 'done';

export interface AgentInfo {
  kind: AgentKind;
  state: AgentState;
  /** The agent's own session id, which a restart resumes; null until known. */
  sessionId: string | null;
}

/**
 * admin: the host's own token. normal: a restricted copy (no privileges, Administrators deny-only,
 * Medium integrity) through vesper-launch; the same as admin when the host is not elevated.
 */
export const ELEVATIONS = ['admin', 'normal'] as const;
export type Elevation = (typeof ELEVATIONS)[number];

interface SessionPlacement { cwd?: string; cols?: number; rows?: number; title?: string; elevation?: Elevation }
export type CreateOptions = SessionPlacement & ({ shell: ShellKind } | { command: LaunchCommand });

export type ControlRequest =
  | { id: number; op: 'ping' | 'list' | 'shutdown' }
  | ({ id: number; op: 'create' } & CreateOptions)
  | { id: number; op: 'kill' | 'remove' | 'restart'; session: string };

export interface ControlResults {
  ping: { pid: number; uptimeMs: number };
  list: { sessions: SessionInfo[] };
  create: { session: SessionInfo };
  restart: { session: SessionInfo };
  kill: Record<string, never>;
  remove: Record<string, never>;
  shutdown: Record<string, never>;
}

export type ControlResponse =
  | { id: number; ok: true; result: ControlResults[keyof ControlResults] }
  | { id: number; ok: false; error: HostErrorCode; message: string };

/** A desktop notification a session's program asked for (OSC 9 or OSC 777); title and body are already cleaned. */
export interface SessionNotice {
  event: 'notice';
  session: string;
  title: string;
  body: string;
  at: number;
}

export type HostEvent = { event: 'session'; session: SessionInfo } | { event: 'removed'; session: string } | SessionNotice;
const HOST_EVENTS: ReadonlySet<unknown> = new Set<HostEvent['event']>(['session', 'removed', 'notice']);

export class HostApiError extends Error {
  override name = 'HostApiError';
  constructor(
    readonly code: HostErrorCode,
    message: string,
    readonly requestId?: number,
  ) {
    super(message);
  }
}

type Fields = Record<string, unknown>;

export function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !value.includes('\0');
}

function fail(message: string, requestId?: number): never {
  throw new HostApiError('bad_request', message, requestId);
}

export function parseSize(value: unknown): TerminalSize {
  if (!isRecord(value) || !isInteger(value.cols, 1, MAX_DIMENSION) || !isInteger(value.rows, 1, MAX_DIMENSION)) {
    fail('invalid terminal size');
  }
  return { cols: value.cols, rows: value.rows };
}

export function parseSessionId(value: unknown, requestId?: number): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) fail('invalid session id', requestId);
  return value;
}

function parseResume(value: unknown): ResumePoint {
  if (!isRecord(value) || !isInteger(value.inc, 0, MAX_U32) || !isInteger(value.seq, 0, Number.MAX_SAFE_INTEGER)) {
    fail('invalid resume point');
  }
  return { inc: value.inc, seq: value.seq };
}

export function parseHello(value: unknown): Hello {
  if (!isRecord(value)) fail('hello must be an object');
  if (!isInteger(value.v, 0, MAX_U32)) fail('missing protocol version');
  if (value.v !== HOST_PROTOCOL_VERSION) {
    throw new HostApiError('version_mismatch', `host speaks v${HOST_PROTOCOL_VERSION}, client sent v${value.v}`);
  }
  if (!isHandshakeValue(value.nonce)) fail('missing nonce');
  if (value.role === 'control') return { v: value.v, nonce: value.nonce, role: 'control' };
  if (value.role !== 'attach') fail('unknown role');
  return {
    v: value.v,
    nonce: value.nonce,
    role: 'attach',
    session: parseSessionId(value.session),
    ...(value.resume === undefined ? {} : { resume: parseResume(value.resume) }),
    ...(value.size === undefined ? {} : { size: parseSize(value.size) }),
  };
}

function isHandshakeValue(value: unknown): value is string {
  return typeof value === 'string' && HANDSHAKE_VALUE.test(value);
}

/** The host's answer to a Hello; a refusal arrives as a HelloReply instead. */
export function parseChallenge(value: unknown): Challenge {
  if (!isRecord(value) || !isHandshakeValue(value.proof) || !isHandshakeValue(value.nonce)) fail('invalid challenge');
  return { proof: value.proof, nonce: value.nonce };
}

export function parseProof(value: unknown): Proof {
  if (!isRecord(value) || !isHandshakeValue(value.proof)) fail('invalid proof');
  return { proof: value.proof };
}

export function parseCreateOptions(value: unknown, requestId?: number): CreateOptions {
  if (!isRecord(value)) fail('create options must be an object', requestId);
  const { shell, command, cwd, cols, rows, title, elevation } = value;
  // Required on the wire: a client that forgets it must not get the host's admin token by default.
  if (!ELEVATIONS.includes(elevation as Elevation)) fail('elevation must be admin or normal', requestId);
  if (cwd !== undefined && !isText(cwd, MAX_PATH)) fail('invalid cwd', requestId);
  if (cols !== undefined && !isInteger(cols, 1, MAX_DIMENSION)) fail('invalid cols', requestId);
  if (rows !== undefined && !isInteger(rows, 1, MAX_DIMENSION)) fail('invalid rows', requestId);
  if (title !== undefined && !isText(title, MAX_TITLE)) fail('invalid title', requestId);
  const placement = {
    ...(cwd === undefined ? {} : { cwd }),
    ...(cols === undefined ? {} : { cols }),
    ...(rows === undefined ? {} : { rows }),
    ...(title === undefined ? {} : { title }),
    elevation: elevation as Elevation,
  };
  if (command !== undefined) {
    if (shell !== undefined) fail('give a shell or a command, not both', requestId);
    return { command: parseLaunchCommand(command, requestId), ...placement };
  }
  if (!SHELL_KINDS.includes(shell as ShellKind)) fail('unknown shell', requestId);
  return { shell: shell as ShellKind, ...placement };
}

export function parseLaunchCommand(value: unknown, requestId?: number): LaunchCommand {
  if (!isRecord(value)) fail('the command must be an object', requestId);
  const { file, args = [], commandLine, label, env, agent } = value;
  if (!isText(label, MAX_TITLE)) fail('invalid command label', requestId);
  if (agent !== undefined && !AGENT_KINDS.includes(agent as AgentKind)) fail('unknown agent', requestId);
  const common = {
    label,
    ...(env === undefined ? {} : { env: parseEnv(env, requestId) }),
    ...(agent === undefined ? {} : { agent: agent as AgentKind }),
  };
  if (commandLine !== undefined) {
    if (file !== undefined || value.args !== undefined) fail('give a file or a command line, not both', requestId);
    if (!isText(commandLine, MAX_CMD_LINE) || /[\r\n]/.test(commandLine)) fail('invalid command line', requestId);
    return { commandLine, ...common };
  }
  if (!isText(file, MAX_PATH) || !LOCAL_ABSOLUTE.test(file)) fail('the command file must be a local absolute path', requestId);
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every(isArgument)) fail('invalid command arguments', requestId);
  if (file.length + args.reduce((total, arg) => total + arg.length + 3, 0) > MAX_COMMAND_LINE) fail('the command is too long', requestId);
  return { file, args, ...common };
}

function isArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_COMMAND_LINE && !value.includes('\0');
}

function parseEnv(value: unknown, requestId?: number): Record<string, string> {
  if (!isRecord(value)) fail('the command environment must be an object', requestId);
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV) fail('too many environment variables', requestId);
  for (const [name, setting] of entries) {
    if (name.length > MAX_ENV_NAME || !ENV_NAME.test(name)) fail('invalid environment variable name', requestId);
    if (!isArgument(setting)) fail('invalid environment variable value', requestId);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseControlRequest(value: unknown): ControlRequest {
  if (!isRecord(value) || !isInteger(value.id, 0, Number.MAX_SAFE_INTEGER)) fail('request needs a numeric id');
  const id = value.id;
  switch (value.op) {
    case 'ping':
    case 'list':
    case 'shutdown':
      return { id, op: value.op };
    case 'create':
      return { id, op: 'create', ...parseCreateOptions(value, id) };
    case 'kill':
    case 'remove':
    case 'restart':
      return { id, op: value.op, session: parseSessionId(value.session, id) };
    default:
      fail('unknown op', id);
  }
}

export function parseHelloReply(value: unknown): HelloReply {
  if (isRecord(value) && value.ok === true && isInteger(value.v, 0, MAX_U32) && isInteger(value.pid, 0, MAX_U32)) {
    return { ok: true, v: value.v, pid: value.pid };
  }
  if (isRecord(value) && value.ok === false && typeof value.error === 'string' && typeof value.message === 'string') {
    return { ok: false, error: value.error as HostErrorCode, message: value.message };
  }
  fail('invalid hello reply');
}

/** Light shape check for messages from the host; the host has proven it holds the token. */
export function parseControlMessage(value: unknown): ControlResponse | HostEvent {
  if (isRecord(value) && HOST_EVENTS.has(value.event)) return value as HostEvent;
  if (isRecord(value) && isInteger(value.id, 0, Number.MAX_SAFE_INTEGER) && typeof value.ok === 'boolean') {
    return value as ControlResponse;
  }
  fail('invalid control message');
}
