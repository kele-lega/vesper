import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** The WebSocket subprotocol the server answers with; the token travels as a second, prefixed entry. */
export const WS_PROTOCOL = 'vesper.v1';
export const WS_TOKEN_PREFIX = 'vesper.token.';

export function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
  return match?.[1];
}

/** Browsers cannot set headers on WebSockets, so the token rides in Sec-WebSocket-Protocol, not the URL. */
export function protocolToken(req: IncomingMessage): string | undefined {
  const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((entry) => entry.trim());
  return offered.find((entry) => entry.startsWith(WS_TOKEN_PREFIX))?.slice(WS_TOKEN_PREFIX.length);
}

interface Strikes {
  count: number;
  since: number;
}

/**
 * Locks out an address after repeated authentication failures. Behind a reverse
 * proxy every request shares one address; per-client keys arrive with login (M4).
 */
export class FailureLimiter {
  private readonly strikes = new Map<string, Strikes>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const entry = this.current(key);
    return entry !== undefined && entry.count >= this.limit;
  }

  fail(key: string): void {
    const entry = this.current(key) ?? { count: 0, since: this.now() };
    if (this.strikes.size > 10_000) this.strikes.clear(); // bound memory under a flood of addresses
    this.strikes.set(key, { ...entry, count: entry.count + 1 });
  }

  private current(key: string): Strikes | undefined {
    const entry = this.strikes.get(key);
    if (entry && this.now() - entry.since > this.windowMs) {
      this.strikes.delete(key);
      return undefined;
    }
    return entry;
  }
}
