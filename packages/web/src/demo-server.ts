/**
 * M0 demo server: one process serves the page and hosts the pty sessions.
 * Not the final architecture (M1 splits the pty host into its own process), and
 * not for exposure: it binds to 127.0.0.1 and needs the per-run token it prints.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { createProcessJob, PtySession, shellLaunchSpec, type ShellKind } from '@vesper/ptyd';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = Number(process.env['VESPER_PORT'] ?? 7690);
const HOST = '127.0.0.1';
const UI_DIST = fileURLToPath(new URL('../../ui/dist/', import.meta.url));
const SHELLS: readonly ShellKind[] = ['powershell', 'cmd', 'gitbash'];
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
    ({ status, type, body }) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body),
    (error: unknown) => {
      console.error('static file error', error);
      res.writeHead(500).end();
    },
  );
});

async function serveStatic(url: string): Promise<{ status: number; type: string; body: Buffer | string }> {
  const pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  const file = normalize(join(UI_DIST, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(UI_DIST.endsWith(sep) ? UI_DIST : UI_DIST + sep)) return { status: 403, type: 'text/plain', body: 'forbidden' };
  try {
    return { status: 200, type: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', body: await readFile(file) };
  } catch {
    return { status: 404, type: 'text/plain', body: 'not found' };
  }
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws' || !validToken(url.searchParams.get('token')) || !allowedOrigins.has(req.headers.origin ?? '')) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const name = /^[\w-]{1,32}$/.test(url.searchParams.get('session') ?? '') ? url.searchParams.get('session')! : 'main';
  const shell = SHELLS.find((kind) => kind === url.searchParams.get('shell')) ?? 'powershell';
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, name, shell, req));
});

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

function attach(ws: WebSocket, name: string, shell: ShellKind, req: IncomingMessage): void {
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

  // Start listening before the snapshot so nothing between snapshot and live output is lost;
  // chunks the snapshot already contains (seq below its offset) are dropped.
  let liveFrom: number | undefined;
  const early: { seq: number; data: Uint8Array }[] = [];
  const stopOutput = hosted.pty.onOutput((chunk) => {
    if (liveFrom === undefined) early.push(chunk);
    else if (chunk.seq >= liveFrom) send({ type: 'output', ...chunk });
  });
  const stopExit = hosted.pty.onExit((code) => send({ type: 'exit', code }));
  void hosted.pty.snapshot().then((snapshot) => {
    send({ type: 'snapshot', seq: snapshot.seq, cols: snapshot.cols, rows: snapshot.rows, data: Buffer.from(snapshot.data) });
    liveFrom = snapshot.seq;
    for (const chunk of early.splice(0)) if (chunk.seq >= snapshot.seq) send({ type: 'output', ...chunk });
  });

  ws.on('message', (raw, isBinary) => {
    if (!isBinary || !(raw instanceof Buffer)) return;
    try {
      handleFrame(hosted, ws, decodeFrame(raw), send);
    } catch (error) {
      console.warn(`bad frame from ${name}: ${(error as Error).message}`);
    }
  });
  ws.on('close', () => {
    stopOutput();
    stopExit();
    hosted.sizes.delete(ws);
    if (hosted.driver === ws) hosted.driver = undefined;
    console.log(`detach ${name} (${hosted.sizes.size} attached, session keeps running)`);
  });
}

function handleFrame(hosted: HostedSession, ws: WebSocket, frame: Frame, send: (frame: Frame) => void): void {
  switch (frame.type) {
    case 'input':
      if (hosted.driver !== ws) {
        hosted.driver = ws;
        applySize(hosted, ws);
      }
      hosted.pty.write(frame.data);
      return;
    case 'resize':
      hosted.sizes.set(ws, { cols: frame.cols, rows: frame.rows });
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
