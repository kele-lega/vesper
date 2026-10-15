import type { CloseReason, Frame, ResumePoint } from '@vesper/protocol';
import { log } from './log.js';
import type { OutputChunk, SizeEvent, Snapshot, TerminalSize } from './session.js';

/** What an attachment streams from: a live PtySession or the restored screen of an exited one. */
export interface OutputSource {
  readonly seq: number;
  readonly exitCode: number | undefined;
  read(from: number, max?: number): Uint8Array | undefined;
  snapshot(): Promise<Snapshot>;
  /** The size in effect at output offset seq. */
  sizeAt(seq: number): SizeEvent;
  /** Size events after the given id, oldest first; ids count up by one. */
  sizeEventsAfter(id: number): SizeEvent[];
  onOutput(listener: (chunk: OutputChunk) => void): () => void;
  onSize(listener: (event: SizeEvent) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
}

export interface AttachPeer {
  send(frame: Frame): void;
  close(): void;
}

export interface AttachmentHooks {
  input(attachment: Attachment, text: string): void;
  resize(attachment: Attachment, size: TerminalSize): void;
}

export interface AttachmentOptions {
  /** The session's current incarnation; a resume point from another one cannot be honoured. */
  inc: number;
  resume?: ResumePoint;
  /** Most output bytes sent but not yet acknowledged. */
  window?: number;
  maxFrame?: number;
}

export const DEFAULT_WINDOW = 512 * 1024;
export const DEFAULT_MAX_FRAME = 64 * 1024;
const encoder = new TextEncoder();

/**
 * One client's view of a session. It resumes from the client's last seq when
 * that output is still retained, otherwise starts from a snapshot, and never
 * has more than `window` bytes unacknowledged. A client that falls so far
 * behind that its next byte has left the ring gets a fresh snapshot.
 *
 * Size changes are sent in stream order: a size frame goes out once every byte
 * before its offset has been sent, so the client resizes at the same point as the pty.
 */
export class Attachment {
  private position = 0;
  private acked = 0;
  private lastSizeId = 0;
  private syncing = true;
  private exitSent = false;
  private closed = false;
  private readonly decoder = new TextDecoder();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly window: number;
  private readonly maxFrame: number;

  constructor(
    private readonly source: OutputSource,
    private readonly peer: AttachPeer,
    private readonly hooks: AttachmentHooks,
    private readonly options: AttachmentOptions,
  ) {
    this.window = options.window ?? DEFAULT_WINDOW;
    this.maxFrame = options.maxFrame ?? DEFAULT_MAX_FRAME;
  }

  start(): void {
    this.unsubscribe.push(this.source.onOutput(() => this.pump()));
    this.unsubscribe.push(this.source.onSize(() => this.pump()));
    this.unsubscribe.push(this.source.onExit(() => this.pump()));
    const { resume, inc } = this.options;
    if (resume && resume.inc === inc && this.source.read(resume.seq, 0) !== undefined) {
      this.position = resume.seq;
      this.acked = resume.seq;
      this.syncing = false;
      // The size at the resume point: a no-op for the client, and the sign that it resumed.
      const size = this.source.sizeAt(resume.seq);
      this.lastSizeId = size.id;
      this.peer.send({ type: 'size', cols: size.cols, rows: size.rows });
      this.pump();
      return;
    }
    void this.resync();
  }

  receive(frame: Frame): void {
    if (this.closed) return;
    switch (frame.type) {
      case 'input': {
        const text = this.decoder.decode(frame.data, { stream: true });
        if (text !== '') this.hooks.input(this, text);
        return;
      }
      case 'resize':
        this.hooks.resize(this, { cols: frame.cols, rows: frame.rows });
        return;
      case 'ack':
        this.ack(frame.seq);
        return;
      default:
        log.warn(`unexpected ${frame.type} frame on an attach channel`);
        this.close();
    }
  }

  /** Stops streaming; with a reason, tells the peer why first. */
  close(reason?: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    if (reason) this.peer.send({ type: 'closed', reason });
    this.peer.close();
  }

  private ack(seq: number): void {
    if (this.syncing || seq <= this.acked) return; // stale: from before a resync, or repeated
    if (seq > this.position) {
      log.warn(`client acknowledged ${seq} but only ${this.position} was sent`);
      this.close();
      return;
    }
    this.acked = seq;
    this.pump();
  }

  private async resync(): Promise<void> {
    this.syncing = true;
    let snapshot: Snapshot;
    try {
      snapshot = await this.source.snapshot();
    } catch (error) {
      log.error('could not take a snapshot for a client', error);
      this.close();
      return;
    }
    if (this.closed) return;
    this.position = snapshot.seq;
    this.acked = snapshot.seq;
    this.lastSizeId = snapshot.sizeEventId;
    this.syncing = false;
    const { inc } = this.options;
    const { seq, cols, rows } = snapshot;
    this.peer.send({ type: 'snapshot', inc, seq, cols, rows, data: encoder.encode(snapshot.data) });
    this.pump();
  }

  private pump(): void {
    if (this.closed || this.syncing) return;
    for (;;) {
      const event = this.source.sizeEventsAfter(this.lastSizeId)[0];
      if (event && event.id !== this.lastSizeId + 1) return this.resyncWhenCaughtUp(); // a size change it can no longer get
      if (event && event.seq <= this.position) {
        this.lastSizeId = event.id;
        this.peer.send({ type: 'size', cols: event.cols, rows: event.rows });
        continue;
      }
      const end = event ? event.seq : this.source.seq;
      const room = this.acked + this.window - this.position;
      if (this.position >= end || room <= 0) break;
      const data = this.source.read(this.position, Math.min(room, this.maxFrame, end - this.position));
      if (data === undefined) return this.resyncWhenCaughtUp();
      this.peer.send({ type: 'output', seq: this.position, data });
      this.position += data.length;
    }
    const code = this.source.exitCode;
    if (code !== undefined && !this.exitSent && this.position >= this.source.seq) {
      this.exitSent = true;
      this.peer.send({ type: 'exit', code });
    }
  }

  /**
   * The next thing this client needs has left the ring. Replace its screen once it
   * has caught up with what it was sent, so a stuck client gets one snapshot, not many.
   */
  private resyncWhenCaughtUp(): void {
    if (this.acked === this.position) void this.resync();
  }
}
