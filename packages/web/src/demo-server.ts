/**
 * M0 demo server: one process serves the page and hosts the pty sessions.
 * Not the final architecture (M1 splits the pty host into its own process), and
 * not for exposure: it binds to 127.0.0.1 and needs the per-run token it prints.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { createProcessJob, PtySession, shellLaunchSpec, type ShellKind } from '@vesper/ptyd';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { attachClient } from './attach.js';

const PORT = Number(process.env['VESPER_PORT'] ?? 7690);
const HOST = '127.0.0.1';
const UI_DIST = fileURLToPath(new URL('../../ui/dist/', import.meta.url));
const UI_ROOT = UI_DIST.endsWith(sep) ? UI_DIST : UI_DIST + sep;
const SHELLS: readonly ShellKind[] = ['powershell', 'cmd', 'gitbash'];
const SESSION_NAME = /^[\w-]{1,32}$/;
/** Closing code that tells the browser the shell ended, so it must not reconnect into a new one. */
const CLOSE_SESSION_ENDED = 4000;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
const SHELL_PATHS = {
  systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
  gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe',
};
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  // xterm.js sets inline styles, so styles may be inline; scripts may not.
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ws://${HOST}:${PORT} ws://localhost:${PORT}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};
const token = randomBytes(18).toString('base64url');
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

interface HostedSession {
  pty: PtySession;
  /** The connection whose window size the pty follows: the one that typed most recently. */
  driver: WebSocket | undefined;
  sizes: Map<WebSocket, { cols: number; rows: number }>;
}
const sessions = new Map<string, HostedSession>();

const server = createServer((req, res) => {
  void serveStatic(req.url ?? '/').then(
    ({ status, type, body }) => res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type }).end(body),
    (error: unknown) => {
      console.error('static file error', error);
      res.writeHead(500, SECURITY_HEADERS).end();
    },
  );
});

async function serveStatic(url: string): Promise<{ status: number; type: string; body: Buffer | string }> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return { status: 400, type: 'text/plain', body: 'bad request' };
  }
  if (pathname.includes('\0')) return { status: 400, type: 'text/plain', body: 'bad request' };
  const file = normalize(join(UI_DIST, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(UI_ROOT)) return { status: 403, type: 'text/plain', body: 'forbidden' };
  try {
    return { status: 200, type: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', body: await readFile(file) };
  } catch {
    return { status: 404, type: 'text/plain', body: 'not found' };
  }
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  // Node removes its own error listener before emitting 'upgrade'; without one, a reset crashes the process.
  socket.on('error', () => socket.destroy());
  const target = parseUpgrade(req);
  if (typeof target === 'number') return reject(socket, target);
  wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, target.name, target.shell, req));
});

function parseUpgrade(req: IncomingMessage): { name: string; shell: ShellKind } | 400 | 403 {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {
    return 400;
  }
  if (url.pathname !== '/ws' || !validToken(url.searchParams.get('token')) || !allowedOrigins.has(req.headers.origin ?? '')) return 403;
  const requested = url.searchParams.get('session') ?? '';
  const name = SESSION_NAME.test(requested) ? requested : 'main';
  const shell = SHELLS.find((kind) => kind === url.searchParams.get('shell')) ?? 'powershell';
  return { name, shell };
}

function reject(socket: Duplex, status: 400 | 403): void {
  const reason = status === 400 ? 'Bad Request' : 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

function validToken(candidate: string | null): boolean {
  const expected = Buffer.from(token);
  const given = Buffer.from(candidate ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function hostSession(name: string, shell: ShellKind): HostedSession {
  const existing = sessions.get(name);
  if (existing) return existing;
  const pty = PtySession.spawn({ launch: shellLaunchSpec(shell, SHELL_PATHS), cwd: tmpdir(), cols: 120, rows: 30 });
  if (pty.jobError) console.warn(`session ${name}: no job object (${pty.jobError.message})`);
  const hosted: HostedSession = { pty, driver: undefined, sizes: new Map() };
  sessions.set(name, hosted);
  pty.onExit(() => sessions.delete(name));
  return hosted;
}

function handleConnection(ws: WebSocket, name: string, shell: ShellKind, req: IncomingMessage): void {
  let hosted: HostedSession;
  try {
    hosted = hostSession(name, shell);
  } catch (error) {
    console.error(`failed to start session ${name}`, error);
    ws.close(1011, 'failed to start shell');
    return;
  }
  console.log(`attach ${name} from ${req.socket.remoteAddress} (${hosted.sizes.size + 1} attached)`);
  const send = (frame: Frame) => {
    if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame));
  };
  const detach = attachClient(hosted.pty, { send, close: () => ws.close(CLOSE_SESSION_ENDED, 'session ended') });
  // One streaming decoder per connection: a character split across two frames stays intact.
  const decoder = new TextDecoder();

  ws.on('message', (raw, isBinary) => handleMessage(hosted, ws, raw, isBinary, decoder, send));
  // ws reports oversized or malformed frames here and then closes the connection.
  ws.on('error', (error) => console.warn(`connection to ${name}: ${error.message}`));
  ws.on('close', () => {
    detach();
    hosted.sizes.delete(ws);
    if (hosted.driver === ws) hosted.driver = undefined;
    console.log(`detach ${name} (${hosted.sizes.size} attached, session keeps running)`);
  });
}

function handleMessage(hosted: HostedSession, ws: WebSocket, raw: RawData, isBinary: boolean, decoder: TextDecoder, send: (frame: Frame) => void): void {
  if (!isBinary || !(raw instanceof Buffer)) return;
  let frame: Frame;
  try {
    frame = decodeFrame(raw);
  } catch (error) {
    console.warn(`bad frame: ${(error as Error).message}`);
    return;
  }
  switch (frame.type) {
    case 'input':
      if (hosted.driver !== ws) {
        hosted.driver = ws;
        applySize(hosted, ws);
      }
      hosted.pty.write(decoder.decode(frame.data, { stream: true }));
      return;
    case 'resize':
      hosted.sizes.set(ws, { cols: Math.min(frame.cols, MAX_COLS), rows: Math.min(frame.rows, MAX_ROWS) });
      if (hosted.driver === ws || hosted.driver === undefined) applySize(hosted, ws);
      return;
    case 'ping':
      send({ type: 'pong', nonce: frame.nonce });
      return;
    default:
      return;
  }
}

function applySize(hosted: HostedSession, ws: WebSocket): void {
  const size = hosted.sizes.get(ws);
  if (size) hosted.pty.resize(size.cols, size.rows);
}

// Every shell started below inherits this job, so they all end when this process does,
// however it exits. The handle stays open for the life of the process.
if (process.platform === 'win32') createProcessJob({ killOnClose: true }).assign(process.pid);

// Warm up ConPTY: the first spawn in a process takes seconds.
PtySession.spawn({ launch: { file: join(SHELL_PATHS.systemRoot, 'System32', 'cmd.exe'), args: ['/c', 'exit'], env: {} }, cwd: tmpdir(), cols: 20, rows: 5 });

server.listen(PORT, HOST, () => {
  console.log(`Vesper M0 demo: http://${HOST}:${PORT}/?token=${token}`);
  console.log('Session state lives in this process; closing the tab keeps shells running until the server stops.');
});
