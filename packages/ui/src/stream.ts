/**
 * Connection bookkeeping that needs no DOM: acknowledgements, keystrokes
 * typed while disconnected, reconnect delays and the socket address.
 */

export const ACK_BYTES = 32 * 1024;
export const ACK_DELAY_MS = 50;
export const INPUT_MAX_AGE_MS = 5000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;

/** Tells the server how far the terminal has parsed: after ACK_BYTES, or ACK_DELAY_MS, whichever comes first. */
export class AckScheduler {
  private acked: number;
  private parsed: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    from: number,
    private readonly send: (seq: number) => void,
    private readonly bytes = ACK_BYTES,
    private readonly delayMs = ACK_DELAY_MS,
  ) {
    this.acked = from;
    this.parsed = from;
  }

  /** Late calls from writes queued before a reconnect are ignored once disposed. */
  parsedThrough(seq: number): void {
    if (this.disposed || seq <= this.parsed) return;
    this.parsed = seq;
    if (this.parsed - this.acked >= this.bytes) return this.flush();
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || this.parsed <= this.acked) return;
    this.acked = this.parsed;
    this.send(this.acked);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * Keystrokes typed while disconnected. They are sent after reconnecting only if
 * the same shell is still there and none waited longer than INPUT_MAX_AGE_MS:
 * a stale "y" must not reach an agent that has moved on.
 */
export class InputQueue {
  private items: { text: string; at: number }[] = [];

  constructor(
    private readonly maxAgeMs = INPUT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.items.length;
  }

  push(text: string): void {
    this.items.push({ text, at: this.now() });
  }

  /** Empties the queue: all of it to send, or all of it dropped. */
  take(sameShell: boolean): { send: string[]; dropped: number } {
    const items = this.items;
    this.items = [];
    const stale = items.length > 0 && items[0]!.at < this.now() - this.maxAgeMs;
    if (!sameShell || stale) return { send: [], dropped: items.length };
    return { send: items.map((item) => item.text), dropped: 0 };
  }
}

/** Exponential backoff from 250 ms to 10 s with ±20% jitter, so many pages do not reconnect in step. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** attempt) * (0.8 + random() * 0.4);
}

export interface SocketTarget {
  session: string;
  resume?: { inc: number; seq: number };
  size?: { cols: number; rows: number };
}

export function socketUrl(location: { protocol: string; host: string }, target: SocketTarget): string {
  const query = new URLSearchParams();
  if (target.resume) {
    query.set('inc', String(target.resume.inc));
    query.set('seq', String(target.resume.seq));
  }
  if (target.size) {
    query.set('cols', String(target.size.cols));
    query.set('rows', String(target.size.rows));
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const search = query.size > 0 ? `?${query}` : '';
  return `${scheme}://${location.host}/ws/sessions/${encodeURIComponent(target.session)}${search}`;
}
