import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { HOST_PROTOCOL_VERSION, HostApiError, isInteger, parseCreateOptions, SESSION_ID_PATTERN, SHELL_KINDS, type HostErrorCode } from '@vesper/protocol';
import { log } from '@vesper/ptyd/client';
import { WebSocketServer } from 'ws';
import { bearerToken, FailureLimiter, protocolToken, sameSecret, WS_PROTOCOL } from './auth.js';
import type { WebConfig } from './config.js';
import { relay, type RelayTarget } from './relay.js';
import { securityHeaders, staticFiles } from './static-files.js';
import type { HostSupervisor } from './supervisor.js';

const MAX_BODY = 64 * 1024;
const MAX_INPUT_FRAME = 1 << 20;
const SESSION_PATH = /^\/api\/sessions\/([^/]+)$/;
const SOCKET_PATH = /^\/ws\/sessions\/([^/]+)$/;
const STATUS: Partial<Record<HostErrorCode, number>> = { bad_request: 400, bad_cwd: 400, not_found: 404, spawn_failed: 500 };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP API, the built UI and the WebSocket relay, on one server. */
export function createApp(config: WebConfig, supervisor: HostSupervisor): Server {
  const headers = securityHeaders(config.origins);
  const serveStatic = staticFiles(config.uiDist);
  const limiter = new FailureLimiter();
  const origins = new Set(config.origins);
  const hosts = allowedHosts(config.origins);
  /**
   * The right token always works, even from an address with many failures: it is
   * 192 random bits, so guessing it is hopeless anyway, while a lockout would hit
   * everyone sharing the address (every request through the reverse proxy comes
   * from 127.0.0.1), letting any web page lock the owner out. Wrong tokens are
   * counted so repeated failures get 429. Password login (M2) brings a real limiter.
   */
  const authorized = (token: string | undefined, req: IncomingMessage): boolean => {
    if (sameSecret(token, config.token)) return true;
    limiter.fail(peerOf(req));
    return false;
  };
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_INPUT_FRAME,
    handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => sendJson(res, headers, status, body);
    // A page on a rebinding domain reaches this server under a foreign Host; refuse it.
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) return reply(421, { error: 'unknown host' });
    if (!(req.url ?? '').startsWith('/api/')) {
      void serveStatic(req.url ?? '/').then(
        ({ status, type, body }) => res.writeHead(status, { ...headers, 'content-type': type }).end(body),
        (error: unknown) => {
          log.error('static file error', error);
          if (!res.headersSent) res.writeHead(500, headers).end();
        },
      );
      return;
    }
    if (!authorized(bearerToken(req), req)) return reply(limiter.blocked(peerOf(req)) ? 429 : 401, { error: 'unauthorized' });
    api(req, config, supervisor).then(
      ([status, body]) => reply(status, body),
      (error: unknown) => {
        const [status, message] = errorStatus(error);
        if (status >= 500) log.error(`${req.method} ${req.url} failed`, error);
        reply(status, { error: message });
      },
    );
  });

  server.on('upgrade', (req, socket, head) => {
    // Node removes its own error listener before 'upgrade'; without one, a reset crashes the process.
    socket.on('error', () => socket.destroy());
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) return refuse(socket, 421, 'Misdirected Request');
    if (!origins.has(req.headers.origin ?? '')) return refuse(socket, 403, 'Forbidden');
    if (!authorized(protocolToken(req), req)) return refuse(socket, 403, 'Forbidden');
    const target = parseTarget(req.url ?? '');
    if (!target) return refuse(socket, 400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, (ws) => relay(ws, supervisor.attachAddress(), target));
  });
  return server;
}

const peerOf = (req: IncomingMessage) => req.socket.remoteAddress ?? '?';

/** Host headers this server answers to: the authorities of the allowed origins. */
function allowedHosts(origins: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const origin of origins) {
    try {
      hosts.add(new URL(origin).host.toLowerCase());
    } catch {
      log.warn(`ignoring the malformed origin ${origin}`);
    }
  }
  return hosts;
}

async function api(req: IncomingMessage, config: WebConfig, supervisor: HostSupervisor): Promise<[number, unknown]> {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/api/config' && req.method === 'GET') {
    return [200, { defaultCwd: config.defaultCwd, shells: SHELL_KINDS, protocol: HOST_PROTOCOL_VERSION }];
  }
  if (path === '/api/sessions') {
    if (req.method === 'GET') return [200, { sessions: await (await supervisor.control()).list() }];
    if (req.method === 'POST') {
      const options = parseCreateOptions(await readJson(req));
      const session = await (await supervisor.control()).create({ ...options, cwd: options.cwd ?? config.defaultCwd });
      return [201, { session }];
    }
    throw new HttpError(405, 'method not allowed');
  }
  const id = SESSION_PATH.exec(path)?.[1];
  if (id === undefined) throw new HttpError(404, 'not found');
  if (!SESSION_ID_PATTERN.test(id)) throw new HttpError(400, 'invalid session id');
  if (req.method === 'GET') {
    const session = (await (await supervisor.control()).list()).find((entry) => entry.id === id);
    if (!session) throw new HttpError(404, 'no such session');
    return [200, { session }];
  }
  if (req.method === 'DELETE') {
    await (await supervisor.control()).remove(id);
    return [200, {}];
  }
  throw new HttpError(405, 'method not allowed');
}

function errorStatus(error: unknown): [number, string] {
  if (error instanceof HttpError) return [error.status, error.message];
  if (error instanceof HostApiError) return [STATUS[error.code] ?? 500, error.message];
  return [503, 'terminal host unavailable'];
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** /ws/sessions/<id>?inc=&seq=&cols=&rows=: the session and, optionally, where the page left off and its size. */
export function parseTarget(url: string): RelayTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://x');
  } catch {
    return undefined;
  }
  const session = SOCKET_PATH.exec(parsed.pathname)?.[1];
  if (session === undefined || !SESSION_ID_PATTERN.test(session)) return undefined;
  const number = (name: string, max: number) => {
    const raw = parsed.searchParams.get(name);
    const value = raw === null || raw === '' ? NaN : Number(raw);
    return isInteger(value, 0, max) ? value : undefined;
  };
  const inc = number('inc', 0xffff_ffff);
  const seq = number('seq', Number.MAX_SAFE_INTEGER);
  const cols = number('cols', 10_000);
  const rows = number('rows', 10_000);
  return {
    session,
    ...(inc !== undefined && seq !== undefined ? { resume: { inc, seq } } : {}),
    ...(cols && rows ? { size: { cols, rows } } : {}),
  };
}

function sendJson(res: ServerResponse, headers: Record<string, string>, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}
