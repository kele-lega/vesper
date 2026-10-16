import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * Request-level pieces of login: where a request really comes from, the session
 * cookie, and the check every state-changing request must pass.
 */

/** `__Host-`: the browser keeps it to this exact host, over HTTPS (or localhost), with Path=/. */
export const SESSION_COOKIE = '__Host-vesper';
/** A header cross-site pages cannot add without a CORS preflight, which this server never grants. */
export const WRITE_HEADER = 'x-vesper';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The client's address. The server listens on loopback only, so remote clients
 * arrive through the reverse proxy, which appends the address it saw as the last
 * X-Forwarded-For entry; earlier entries are whatever the client sent and are ignored.
 */
export function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress;
  if (peer === undefined) return 'unknown';
  if (!LOOPBACK.has(peer)) return peer;
  const last = [req.headers['x-forwarded-for'] ?? ''].flat().join(',').split(',').at(-1)?.trim() ?? '';
  return isIP(last) !== 0 ? last : peer;
}

export function sessionCookie(token: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return sessionCookie('', 0);
}

export function sessionToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=');
  }
  return undefined;
}

/** Why a state-changing request is refused; undefined when it may go ahead. */
export function writeCheck(req: IncomingMessage, origins: readonly string[]): string | undefined {
  const origin = req.headers.origin;
  if (origin === undefined || !origins.includes(origin)) return 'origin not allowed';
  if (req.headers[WRITE_HEADER] !== '1') return `missing ${WRITE_HEADER} header`;
  return undefined;
}
