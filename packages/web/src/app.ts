import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Duplex } from 'node:stream';
import { CONTROL_SOCKET_PATH, HostApiError, isInteger, SESSION_ID_PATTERN, type HostErrorCode } from '@vesper/protocol';
import { log } from '@vesper/ptyd/client';
import { WebSocketServer } from 'ws';
import { protocolTicket, WS_PROTOCOL } from './auth.js';
import type { WebConfig } from './config.js';
import { ControlHub, DeviceSockets } from './control-hub.js';
import { LoginGate, type GateReply } from './login.js';
import type { LoginLimits } from './login-limiter.js';
import { defaultProfiles, ProfileStore } from './profile-store.js';
import { NoticeStore } from './notice-store.js';
import { ProjectStore } from './project-store.js';
import { SettingsStore } from './settings-store.js';
import { relay, type RelayTarget } from './relay.js';
import { securityHeaders, staticFiles } from './static-files.js';
import { writeCheck } from './request-auth.js';
import type { HostSupervisor } from './supervisor.js';
import { TabStore } from './tab-store.js';
import { openWebDatabase } from './web-db.js';
import { HttpError, route, routeErrorStatus } from './web-routes.js';
import { parseWtProfiles } from './wt-import.js';

const MAX_BODY = 64 * 1024;
const MAX_INPUT_FRAME = 1 << 20;
/** A new password set from the CLI signs devices out; their open sockets are closed this often. */
const LOGIN_RECHECK_MS = 60_000;
const SOCKET_PATH = /^\/ws\/sessions\/([^/]+)$/;
const STATUS: Partial<Record<HostErrorCode, number>> = { bad_request: 400, bad_cwd: 400, not_found: 404, spawn_failed: 500 };

export interface AppOptions {
  /** An open web database; by default config.database is opened. */
  db?: DatabaseSync;
  loginLimits?: LoginLimits;
}

/** The HTTP API, the built UI and the WebSocket relays, on one server. */
export function createApp(config: WebConfig, supervisor: HostSupervisor, options: AppOptions = {}): Server {
  const db = options.db ?? openWebDatabase(config.database);
  const projects = new ProjectStore(db);
  const tabs = new TabStore(db);
  const profiles = new ProfileStore(db);
  if (profiles.seed(() => firstProfiles(config))) log.info(`set up ${profiles.list().length} profiles`);
  const gate = new LoginGate({ db, origins: config.origins, ...(options.loginLimits ? { limits: options.loginLimits } : {}) });
  const notices = new NoticeStore(db);
  const settings = new SettingsStore(db, config.defaultCwd);
  const hub = new ControlHub({ projects, tabs, profiles, notices });
  const deps = { settings, supervisor, hub, projects, tabs, profiles, notices };
  const sockets = new DeviceSockets();
  gate.onRevoke((device) => sockets.closeDevice(device));
  const recheck = setInterval(() => sockets.closeUnless((device) => gate.stillLoggedIn(device)), LOGIN_RECHECK_MS).unref();
  supervisor.onClient((client) => void hub.adopt(client).catch((error: unknown) => log.error('could not follow the terminal host', error)));

  const headers = securityHeaders(config.origins);
  const serveStatic = staticFiles(config.uiDist);
  const origins = new Set(config.origins);
  const hosts = allowedHosts(config.origins);
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_INPUT_FRAME,
    handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => sendJson(res, { ...headers, ...extra }, status, body);
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
    void handleApi(req).then(
      ({ status, body, cookie, retryAfterS }) =>
        reply(status, body, { ...(cookie ? { 'set-cookie': cookie } : {}), ...(retryAfterS ? { 'retry-after': String(retryAfterS) } : {}) }),
      (error: unknown) => {
        const [status, message] = errorStatus(error);
        if (status >= 500) log.error(`${req.method} ${req.url} failed`, error);
        reply(status, { error: message });
      },
    );
  });

  /** Login routes are open; everything else needs a logged-in device, and changes need the write check. */
  async function handleApi(req: IncomingMessage): Promise<GateReply> {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = () => readJson(req);
    const login = await gate.route(req, url.pathname, body);
    if (login) return login;
    const current = gate.device(req);
    if (!current) return { status: 401, body: { error: 'unauthorized' } };
    const problem = req.method === 'GET' || req.method === 'HEAD' ? undefined : writeCheck(req, config.origins);
    if (problem) return { status: 403, body: { error: problem } };
    const result = await route(deps, req.method ?? 'GET', url.pathname, { body, query: url.searchParams });
    if (!result) throw new HttpError(404, 'not found');
    return { status: result[0], body: result[1], ...(current.cookie ? { cookie: current.cookie } : {}) };
  }

  server.on('upgrade', (req, socket, head) => {
    // Node removes its own error listener before 'upgrade'; without one, a reset crashes the process.
    socket.on('error', () => socket.destroy());
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) return refuse(socket, 421, 'Misdirected Request');
    if (!origins.has(req.headers.origin ?? '')) return refuse(socket, 403, 'Forbidden');
    const ticket = protocolTicket(req);
    const device = ticket === undefined ? undefined : gate.redeemTicket(ticket);
    if (device === undefined) return refuse(socket, 403, 'Forbidden');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === CONTROL_SOCKET_PATH) {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.track(ws, device);
        hub.accept(ws);
      });
    }
    const target = parseTarget(req.url ?? '');
    if (!target) return refuse(socket, 400, 'Bad Request');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.track(ws, device);
      relay(ws, supervisor.attachAddress(), target);
    });
  });
  server.on('close', () => clearInterval(recheck));
  return server;
}

/** First-start profiles: Windows Terminal's (names and command lines only), then built-in shells and agents. */
function firstProfiles(config: WebConfig) {
  const { wtSettings, appData, gitBash } = config.profileSources;
  let imported: ReturnType<typeof parseWtProfiles> = [];
  if (wtSettings) {
    try {
      imported = parseWtProfiles(readFileSync(wtSettings, 'utf8'));
    } catch (error) {
      log.warn('could not read the Windows Terminal settings; starting with built-in profiles', error);
    }
  }
  return defaultProfiles(imported, { appData, gitBash, exists: existsSync });
}

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

function errorStatus(error: unknown): [number, string] {
  const known = routeErrorStatus(error);
  if (known) return known;
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
