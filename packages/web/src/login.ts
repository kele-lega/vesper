import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { log } from '@vesper/ptyd/client';
import { AuditStore } from './audit-store.js';
import { AuthStore, SESSION_MS, type Device } from './auth-store.js';
import { DEFAULT_LOGIN_LIMITS, LoginLimiter, type LoginLimits } from './login-limiter.js';
import { verifyPassword } from './password.js';
import { clearSessionCookie, clientAddress, sessionCookie, sessionToken, writeCheck } from './request-auth.js';
import { TicketBook } from './ws-tickets.js';

/** Longest password text looked at; longer input is refused before any hashing. */
const MAX_PASSWORD_INPUT = 4096;

export interface GateReply {
  status: number;
  body: unknown;
  /** A Set-Cookie value to send with the reply. */
  cookie?: string;
  retryAfterS?: number;
}

export interface GateOptions {
  db: DatabaseSync;
  origins: readonly string[];
  limits?: LoginLimits;
  /** How the global login cap holds an attempt back; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Password login for the one owner: /api/login, /api/logout, /api/session and
 * /api/ws-ticket, plus the cookie and ticket checks the rest of the server uses.
 */
export class LoginGate {
  private readonly auth: AuthStore;
  readonly audit: AuditStore;
  private readonly limiter: LoginLimiter;
  private readonly tickets = new TicketBook();
  private readonly revoked = new Set<(device: string) => void>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GateOptions) {
    this.auth = new AuthStore(options.db);
    this.audit = new AuditStore(options.db);
    this.limiter = new LoginLimiter(options.limits ?? DEFAULT_LOGIN_LIMITS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The logged-in device of a request; `cookie` is set when the login was extended and must be resent. */
  device(req: IncomingMessage): { device: Device; cookie?: string } | undefined {
    const token = sessionToken(req);
    const found = token === undefined ? undefined : this.auth.authenticate(token, clientAddress(req));
    if (!found) return undefined;
    return { device: found.device, ...(found.renewed && token ? { cookie: sessionCookie(token, SESSION_MS) } : {}) };
  }

  /** The device a WebSocket ticket was issued to, if it is still logged in. */
  redeemTicket(ticket: string): string | undefined {
    const device = this.tickets.redeem(ticket);
    return device !== undefined && this.auth.hasDevice(device) ? device : undefined;
  }

  /** Whether a device is still logged in (a new password set from the CLI signs every device out). */
  stillLoggedIn(device: string): boolean {
    return this.auth.hasDevice(device);
  }

  /** Called with a device id when it logs out, so its open sockets can be closed. */
  onRevoke(listener: (device: string) => void): () => void {
    this.revoked.add(listener);
    return () => this.revoked.delete(listener);
  }

  /** Handles the login routes; undefined for any other path. */
  async route(req: IncomingMessage, path: string, readBody: () => Promise<unknown>): Promise<GateReply | undefined> {
    switch (path) {
      case '/api/session':
        return req.method === 'GET' ? this.session(req) : { status: 405, body: { error: 'method not allowed' } };
      case '/api/login':
        return req.method === 'POST' ? this.login(req, readBody) : { status: 405, body: { error: 'method not allowed' } };
      case '/api/logout':
        return req.method === 'POST' ? this.logout(req) : { status: 405, body: { error: 'method not allowed' } };
      case '/api/ws-ticket':
        return req.method === 'POST' ? this.ticket(req) : { status: 405, body: { error: 'method not allowed' } };
      default:
        return this.manage(req, path);
    }
  }

  private session(req: IncomingMessage): GateReply {
    const passwordSet = this.auth.passwordHash() !== undefined;
    const current = this.device(req);
    if (!current) return { status: 200, body: { loggedIn: false, passwordSet } };
    return { status: 200, body: { loggedIn: true, passwordSet, device: current.device }, ...(current.cookie ? { cookie: current.cookie } : {}) };
  }

  private async login(req: IncomingMessage, readBody: () => Promise<unknown>): Promise<GateReply> {
    const problem = writeCheck(req, this.options.origins);
    if (problem) return { status: 403, body: { error: problem } };
    const ip = clientAddress(req);
    const admission = this.limiter.admit(ip);
    if (!admission.ok) {
      const retryAfterS = Math.ceil(admission.retryAfterMs / 1000);
      return { status: 429, body: { error: '尝试太多次，请稍后再试', retryAfterS }, retryAfterS };
    }
    if (admission.waitMs > 0) await this.sleep(admission.waitMs);
    const password = ((await readBody()) as { password?: unknown } | null)?.password;
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_INPUT) return { status: 400, body: { error: 'invalid password field' } };
    const stored = this.auth.passwordHash();
    if (stored === undefined) return { status: 503, body: { error: '还没有设置密码：请在这台电脑上运行 npm run set-password' } };
    if (!(await verifyPassword(password, stored))) {
      this.limiter.failed(ip);
      this.audit.add('login_failed', { ip });
      log.warn(`failed login from ${ip}`);
      return { status: 401, body: { error: '密码不对' } };
    }
    this.limiter.succeeded(ip);
    const { token, device } = this.auth.createDevice(deviceName(req.headers['user-agent'] ?? ''), ip);
    this.audit.add('login', { device: device.id, ip }, device.name);
    log.info(`login from ${ip} (${device.name})`);
    return { status: 200, body: { device }, cookie: sessionCookie(token, SESSION_MS) };
  }

  private logout(req: IncomingMessage): GateReply {
    const problem = writeCheck(req, this.options.origins);
    if (problem) return { status: 403, body: { error: problem } };
    const current = this.device(req);
    if (current) {
      this.signOut(current.device.id);
      this.audit.add('logout', { device: current.device.id, ip: clientAddress(req) }, current.device.name);
    }
    return { status: 200, body: {}, cookie: clearSessionCookie() };
  }

  private signOut(device: string): boolean {
    const known = this.auth.revokeKnown(device);
    this.tickets.revokeDevice(device);
    for (const listener of this.revoked) listener(device);
    return known;
  }

  /** GET /api/devices, DELETE /api/devices/<id>, GET /api/audit: for a logged-in device. */
  manage(req: IncomingMessage, path: string): GateReply | undefined {
    const device = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(path)?.[1];
    if (path !== '/api/devices' && path !== '/api/audit' && device === undefined) return undefined;
    const current = this.device(req);
    if (!current) return { status: 401, body: { error: 'unauthorized' } };
    const cookie = current.cookie ? { cookie: current.cookie } : {};
    if (device !== undefined) {
      if (req.method !== 'DELETE') return { status: 405, body: { error: 'method not allowed' } };
      const problem = writeCheck(req, this.options.origins);
      if (problem) return { status: 403, body: { error: problem } };
      if (!this.signOut(device)) return { status: 404, body: { error: 'no such device' }, ...cookie };
      this.audit.add('device_revoked', { device: current.device.id, ip: clientAddress(req) }, device);
      return { status: 200, body: {}, ...cookie };
    }
    if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
    const body = path === '/api/audit' ? { entries: this.audit.recent() } : { current: current.device.id, devices: this.auth.list() };
    return { status: 200, body, ...cookie };
  }

  private ticket(req: IncomingMessage): GateReply {
    const current = this.device(req);
    if (!current) return { status: 401, body: { error: 'unauthorized' } };
    const problem = writeCheck(req, this.options.origins);
    if (problem) return { status: 403, body: { error: problem } };
    return { status: 200, body: { ticket: this.tickets.issue(current.device.id) }, ...(current.cookie ? { cookie: current.cookie } : {}) };
  }
}

/** A short label for the device list, such as "Edge · Windows"; never echoes the raw User-Agent. */
export function deviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : undefined;
  const os = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Mac OS X/.test(userAgent)
            ? 'macOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : undefined;
  if (!browser && !os) return '未知浏览器';
  return [browser ?? '浏览器', os].filter(Boolean).join(' · ');
}
