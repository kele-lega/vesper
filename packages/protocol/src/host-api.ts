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

export const HOST_PROTOCOL_VERSION = 2;
export const SHELL_KINDS = ['powershell', 'cmd', 'gitbash'] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_DIMENSION = 10_000;
const HANDSHAKE_VALUE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_PATH = 32_767;
const MAX_TITLE = 256;
const MAX_U32 = 0xffff_ffff;

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
  shell: ShellKind;
  title: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  inc: number;
  cols: number;
  rows: number;
  createdAt: number;
  attached: number;
}

export interface CreateOptions { shell: ShellKind; cwd?: string; cols?: number; rows?: number; title?: string }

export type ControlRequest =
  | { id: number; op: 'ping' | 'list' | 'shutdown' }
  | ({ id: number; op: 'create' } & CreateOptions)
  | { id: number; op: 'kill' | 'remove'; session: string };

export interface ControlResults {
  ping: { pid: number; uptimeMs: number };
  list: { sessions: SessionInfo[] };
  create: { session: SessionInfo };
  kill: Record<string, never>;
  remove: Record<string, never>;
  shutdown: Record<string, never>;
}

export type ControlResponse =
  | { id: number; ok: true; result: ControlResults[keyof ControlResults] }
  | { id: number; ok: false; error: HostErrorCode; message: string };

export type HostEvent = { event: 'session'; session: SessionInfo } | { event: 'removed'; session: string };

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
  const { shell, cwd, cols, rows, title } = value;
  if (!SHELL_KINDS.includes(shell as ShellKind)) fail('unknown shell', requestId);
  if (cwd !== undefined && !isText(cwd, MAX_PATH)) fail('invalid cwd', requestId);
  if (cols !== undefined && !isInteger(cols, 1, MAX_DIMENSION)) fail('invalid cols', requestId);
  if (rows !== undefined && !isInteger(rows, 1, MAX_DIMENSION)) fail('invalid rows', requestId);
  if (title !== undefined && !isText(title, MAX_TITLE)) fail('invalid title', requestId);
  return {
    shell: shell as ShellKind,
    ...(cwd === undefined ? {} : { cwd }),
    ...(cols === undefined ? {} : { cols }),
    ...(rows === undefined ? {} : { rows }),
    ...(title === undefined ? {} : { title }),
  };
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
  if (isRecord(value) && (value.event === 'session' || value.event === 'removed')) return value as HostEvent;
  if (isRecord(value) && isInteger(value.id, 0, Number.MAX_SAFE_INTEGER) && typeof value.ok === 'boolean') {
    return value as ControlResponse;
  }
  fail('invalid control message');
}
