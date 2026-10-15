import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { api, ApiError, token, UnauthorizedError } from './api.js';
import { splitInput } from './input.js';
import { AckScheduler, InputQueue, reconnectDelay, socketUrl } from './stream.js';

const WS_PROTOCOL = 'vesper.v1';
const WS_TOKEN_PREFIX = 'vesper.token.';
const PING_INTERVAL_MS = 10_000;
const DEAD_AFTER_MS = 2 * PING_INTERVAL_MS;
/** Keeps every input frame far below the server's 1 MiB frame limit. */
const MAX_INPUT_CHARS = 16_384;
const CLOSE_REMOVED = 4000;
const CLOSE_NOT_FOUND = 4004;

export type ConnectionState = 'connecting' | 'online' | 'offline';
export type EndReason = 'removed' | 'unauthorized';

export interface ConnectionHandlers {
  /** Replace the screen; call parsed() once the terminal has processed data. */
  snapshot(frame: Extract<Frame, { type: 'snapshot' }>, parsed: () => void): void;
  output(data: Uint8Array, parsed: () => void): void;
  size(cols: number, rows: number): void;
  exit(code: number): void;
  state(state: ConnectionState, detail: { rtt?: number }): void;
  /** Keystrokes typed while offline that were not sent, and why. */
  dropped(count: number, reason: 'stale' | 'new-shell'): void;
  ended(reason: EndReason): void;
}

/**
 * One terminal page's link to its session. Reconnects on its own and resumes
 * from the last byte received, so nothing is lost or shown twice; a shell
 * restarted in the meantime arrives as a fresh snapshot.
 */
export class TerminalConnection {
  private socket: WebSocket | undefined;
  private inc: number | undefined;
  private received = 0;
  private resumable = false;
  private synced = false;
  private ended = false;
  private exitShown = false;
  private attempt = 0;
  private lastFrameAt = 0;
  private acks: AckScheduler | undefined;
  private ping: { nonce: number; sentAt: number } | undefined;
  private readonly queue = new InputQueue();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly session: string,
    private readonly handlers: ConnectionHandlers,
    private readonly wantedSize: () => { cols: number; rows: number } | undefined,
  ) {}

  start(): void {
    this.connect();
    setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    window.addEventListener('online', () => this.reconnectIfDown());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectIfDown();
    });
  }

  input(text: string): void {
    if (this.ended) return;
    if (!this.synced) return this.queue.push(text);
    for (const piece of splitInput(text, MAX_INPUT_CHARS)) this.send({ type: 'input', data: this.encoder.encode(piece) });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows });
  }

  private send(frame: Frame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeFrame(frame));
  }

  private connect(): void {
    const size = this.wantedSize();
    const resume = this.resumable && this.inc !== undefined ? { inc: this.inc, seq: this.received } : undefined;
    const ws = new WebSocket(socketUrl(location, { session: this.session, ...(resume ? { resume } : {}), ...(size ? { size } : {}) }), [
      WS_PROTOCOL,
      WS_TOKEN_PREFIX + token(),
    ]);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    this.synced = false;
    this.handlers.state('connecting', {});
    ws.onopen = () => {
      this.lastFrameAt = performance.now();
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws || !(event.data instanceof ArrayBuffer)) return;
      this.lastFrameAt = performance.now();
      let frame: Frame;
      try {
        frame = decodeFrame(new Uint8Array(event.data));
      } catch (error) {
        console.warn('ignoring a malformed frame', error);
        return;
      }
      this.receive(frame);
    };
    ws.onclose = (event) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.synced = false;
      this.acks?.dispose();
      this.acks = undefined;
      void this.handleClose(event.code);
    };
  }

  private receive(frame: Frame): void {
    switch (frame.type) {
      case 'snapshot':
        return this.handleSnapshot(frame);
      case 'output':
        return this.handleOutput(frame);
      case 'size':
        this.handlers.size(frame.cols, frame.rows);
        // The first frame of a resumed stream: acknowledge from where it resumed.
        this.acks ??= this.newAcks(this.received);
        return this.markSynced(true);
      case 'exit':
        if (this.exitShown) return;
        this.exitShown = true;
        return this.handlers.exit(frame.code);
      case 'pong':
        if (this.ping?.nonce !== frame.nonce) return;
        this.handlers.state('online', { rtt: performance.now() - this.ping.sentAt });
        this.ping = undefined;
        return;
      default:
        return;
    }
  }

  private handleSnapshot(frame: Extract<Frame, { type: 'snapshot' }>): void {
    const sameShell = this.inc === undefined || this.inc === frame.inc;
    this.inc = frame.inc;
    this.received = frame.seq;
    this.resumable = true;
    this.exitShown = false; // a new screen: its exit, if any, is shown again
    this.acks?.dispose();
    const acks = this.newAcks(frame.seq);
    this.acks = acks;
    this.handlers.snapshot(frame, () => acks.flush());
    this.markSynced(sameShell);
  }

  private handleOutput(frame: Extract<Frame, { type: 'output' }>): void {
    if (frame.seq !== this.received) {
      // A gap or an overlap: the screen can no longer be trusted, so start over from a snapshot.
      console.warn(`output at ${frame.seq}, expected ${this.received}; resynchronising`);
      this.resumable = false;
      return this.reconnectNow();
    }
    const end = frame.seq + frame.data.length;
    this.received = end;
    const acks = this.acks;
    this.handlers.output(frame.data, () => acks?.parsedThrough(end));
  }

  private newAcks(from: number): AckScheduler {
    return new AckScheduler(from, (seq) => this.send({ type: 'ack', seq }));
  }

  private markSynced(sameShell: boolean): void {
    if (this.synced) return;
    this.synced = true;
    this.attempt = 0;
    this.handlers.state('online', {});
    const { send, dropped } = this.queue.take(sameShell);
    if (dropped > 0) this.handlers.dropped(dropped, sameShell ? 'stale' : 'new-shell');
    for (const text of send) this.input(text);
  }

  private async handleClose(code: number): Promise<void> {
    if (code === CLOSE_REMOVED || code === CLOSE_NOT_FOUND) return this.end('removed');
    this.handlers.state('offline', {});
    // A refused upgrade looks like any other drop (1006); ask the API why.
    try {
      await api('GET', `/api/sessions/${encodeURIComponent(this.session)}`);
    } catch (error) {
      if (error instanceof UnauthorizedError) return this.end('unauthorized');
      if (error instanceof ApiError && error.status === 404) return this.end('removed');
      // anything else (host restarting, network down): keep trying
    }
    setTimeout(() => {
      if (!this.socket && !this.ended) this.connect();
    }, reconnectDelay(this.attempt++));
  }

  private end(reason: EndReason): void {
    this.ended = true;
    this.acks?.dispose();
    this.handlers.ended(reason);
  }

  private reconnectNow(): void {
    if (this.ended) return;
    const old = this.socket;
    this.socket = undefined;
    old?.close();
    this.connect();
  }

  private reconnectIfDown(): void {
    if (this.socket?.readyState !== WebSocket.OPEN && this.socket?.readyState !== WebSocket.CONNECTING) this.reconnectNow();
  }

  private heartbeat(): void {
    if (this.ended || this.socket?.readyState !== WebSocket.OPEN) return;
    // A dead TCP connection may not report its close for minutes; give up on it ourselves.
    if (performance.now() - this.lastFrameAt > DEAD_AFTER_MS) return this.reconnectNow();
    this.ping = { nonce: Math.floor(Math.random() * 0xffff_ffff), sentAt: performance.now() };
    this.send({ type: 'ping', nonce: this.ping.nonce });
  }
}
