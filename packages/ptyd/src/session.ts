import { Buffer } from 'node:buffer';
import nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { Listeners, log } from './log.js';
import { ScreenMirror } from './mirror.js';
import { conptyResizePrelude, firstCursorPosition, shiftRows } from './resize-prelude.js';
import { RingBuffer } from './ring-buffer.js';
import { buildEnv, type LaunchSpec } from './shells.js';
import { openSequenceRemainder, snapshotCut } from './vt-tail.js';
import { createProcessJob, type ProcessJob } from './windows-job.js';

export interface SessionOptions {
  launch: LaunchSpec;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  scrollback?: number;
  /** A mirror already holding restored history; it must have finished parsing (see ScreenMirror.flush). */
  mirror?: ScreenMirror;
  /** Bytes of recent output kept for resuming clients. */
  ringCapacity?: number;
  /** Unparsed bytes the mirror may queue before the pty is paused. */
  mirrorHighWatermark?: number;
  /** The pty resumes once the mirror's queue drains below this. */
  mirrorLowWatermark?: number;
}

/** A chunk of pty output; seq is the byte offset of data[0] in the session's output stream. */
export interface OutputChunk {
  seq: number;
  data: Uint8Array;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** The pty size from output offset seq on. Ids count up by one from 0, the size at spawn. */
export interface SizeEvent extends TerminalSize {
  id: number;
  seq: number;
}

/** Serialized screen and scrollback, exactly as of output offset seq and size event sizeEventId. */
export interface Snapshot extends TerminalSize {
  seq: number;
  data: string;
  sizeEventId: number;
}

type PauseReason = 'mirror' | 'resize';

const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_RING_CAPACITY = 2 << 20;
const DEFAULT_HIGH_WATERMARK = 4 << 20;
const DEFAULT_LOW_WATERMARK = 1 << 20;
const MAX_SIZE_EVENTS = 1024;
/** How long a resize waits for the rest of an escape sequence the output stopped inside. */
const OPEN_SEQUENCE_WAIT_MS = 100;
const OPEN_SEQUENCE_POLL_MS = 10;
/** Before a resize: this long without input or output, so nothing for the old size is still in flight. */
const RESIZE_QUIET_MS = 50;
const RESIZE_QUIET_MAX_MS = 250;
const MIN_COLS = 2; // xterm.js does not go below 2 columns
const MIN_ROWS = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
const TERMINAL_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };

/**
 * One ConPTY session plus a headless xterm mirror of its screen and a ring of
 * its recent output.
 *
 * The mirror is the only party that answers terminal queries (DA1, cursor
 * position, colours, ...). The bundled ConPTY waits for a DA1 reply at startup, and
 * with several browsers attached, browser replies would arrive more than once.
 *
 * Resizes happen at a fixed point of the output stream: output is held while the
 * mirror catches up, a prelude that rearranges rows the way ConPTY does is
 * appended, and a size event marks where the new size starts. Every viewer
 * replays the same bytes and resizes at the same offset.
 */
export class PtySession {
  static spawn(options: SessionOptions): PtySession {
    const env = buildEnv(process.env, TERMINAL_ENV, options.launch.env, options.env ?? {});
    const size = clampSize(options.cols, options.rows);
    const mirror =
      options.mirror ?? new ScreenMirror({ ...size, scrollback: options.scrollback ?? DEFAULT_SCROLLBACK });
    let pty: IPty | undefined;
    try {
      mirror.resize(size.cols, size.rows);
      pty = nodePty.spawn(options.launch.file, options.launch.args, {
        name: TERMINAL_ENV.TERM,
        ...size,
        cwd: options.launch.cwd ?? options.cwd,
        env,
        useConpty: true,
        // The ConPTY bundled with node-pty: newer than Windows 10's built-in one and
        // does not leak a conhost.exe per exited shell (microsoft/node-pty#965).
        useConptyDll: true,
      });
      const { job, jobError } = process.platform === 'win32' ? joinNewJob(pty.pid) : {};
      const ring = new RingBuffer(options.ringCapacity ?? DEFAULT_RING_CAPACITY);
      return new PtySession(pty, mirror, ring, job, jobError, watermarks(options));
    } catch (error) {
      pty?.kill(); // never leave a shell running that nothing owns
      if (!options.mirror) mirror.dispose();
      throw error;
    }
  }

  private exitCodeValue: number | undefined;
  private exitPending: number | undefined;
  private disposed = false;
  private pendingMirrorBytes = 0;
  private readonly pauses = new Set<PauseReason>();
  private readyScheduled = false;
  // Declared before readyPromise, whose initializer assigns it.
  private resolveReady: () => void = () => undefined;
  /** node-pty defers resize and kill until the first output, so resizes wait for it. */
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private wanted: TerminalSize;
  private resizeRun: Promise<void> | undefined;
  private holdChain: Promise<void> = Promise.resolve();
  private holding = false;
  private held: string[] = [];
  /**
   * Set by a resize and kept until it is used: the next absolute cursor position
   * from ConPTY is checked against ours (see realign).
   */
  private realignPending = false;
  private lastIoAt = 0;
  private readonly sizeLog: SizeEvent[];
  private readonly outputListeners = new Listeners<OutputChunk>('session output');
  private readonly exitListeners = new Listeners<number>('session exit');
  private readonly sizeListeners = new Listeners<SizeEvent>('session size');
  private readonly ptySubscriptions: { dispose(): void }[];

  private constructor(
    private readonly pty: IPty,
    readonly mirror: ScreenMirror,
    private readonly ring: RingBuffer,
    private readonly job: ProcessJob | undefined,
    /** Why the shell runs without a job (it may have exited already); kill then only ends the shell. */
    readonly jobError: Error | undefined,
    private readonly watermarks: { high: number; low: number },
  ) {
    this.wanted = mirror.size;
    this.sizeLog = [{ id: 0, seq: 0, ...mirror.size }];
    mirror.onReply((reply) => this.writeToPty(reply));
    this.ptySubscriptions = [
      pty.onData((text) => this.handleOutput(text)),
      // node-pty can report the exit before its native thread has stored the code.
      pty.onExit(({ exitCode }) => this.handleExit(exitCode ?? -1)),
    ];
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Total bytes of output so far; the seq of the next chunk. */
  get seq(): number {
    return this.ring.end;
  }

  get exitCode(): number | undefined {
    return this.exitCodeValue;
  }

  /** The size of the output stream's end (the latest size event). */
  get size(): TerminalSize {
    const { cols, rows } = this.sizeLog.at(-1)!;
    return { cols, rows };
  }

  onOutput(listener: (chunk: OutputChunk) => void): () => void {
    return this.outputListeners.add(listener);
  }

  onSize(listener: (event: SizeEvent) => void): () => void {
    return this.sizeListeners.add(listener);
  }

  /** Calls the listener once with the exit code, also when the session has already exited. */
  onExit(listener: (code: number) => void): () => void {
    const code = this.exitCodeValue;
    if (code !== undefined) {
      queueMicrotask(() => listener(code));
      return () => undefined;
    }
    return this.exitListeners.add(listener);
  }

  /** Output from offset `from` (at most `max` bytes), or undefined once it has left the ring. */
  read(from: number, max?: number): Uint8Array | undefined {
    return this.ring.read(from, max);
  }

  /** The size in effect at output offset seq: the last size event at or before it. */
  sizeAt(seq: number): SizeEvent {
    let found = this.sizeLog[0]!;
    for (const event of this.sizeLog) {
      if (event.seq > seq) break;
      found = event;
    }
    return found;
  }

  sizeEventsAfter(id: number): SizeEvent[] {
    return this.sizeLog.filter((event) => event.id > id);
  }

  write(input: string): void {
    this.writeToPty(input);
  }

  /** Asks for a new size; it takes effect at a later point of the output stream (see onSize). */
  resize(cols: number, rows: number): void {
    if (this.exitCodeValue !== undefined || this.disposed) return;
    this.wanted = clampSize(cols, rows);
    if (this.resizeRun === undefined && !sameSize(this.wanted, this.size)) this.resizeRun = this.runResizes();
  }

  /** Ends the shell and every process it started, detached ones included. */
  kill(): void {
    if (this.exitCodeValue !== undefined) return;
    try {
      this.job?.terminate(1);
    } catch (error) {
      log.warn(`could not end the process tree of pid ${this.pty.pid}`, error);
    } finally {
      this.pty.kill();
    }
  }

  /**
   * Screen and scrollback as of output offset seq. If the output so far ends inside
   * an escape sequence, seq is moved back to its start and the snapshot reflects
   * nothing of it, so replaying from seq leaves a fresh terminal in the same state.
   */
  snapshot(): Promise<Snapshot> {
    const end = this.ring.end;
    return new Promise((resolve) => {
      // The callback runs right after every byte before `end` has been parsed and
      // before any later chunk is, so serializing inside it matches `end` exactly.
      this.mirror.write('', () => {
        const last = this.sizeLog.at(-1)!;
        const cut = snapshotCut(this.ring, end);
        // Never cut back across a resize: the bytes before it were for the old size.
        const seq = last.seq > cut ? end : cut;
        resolve({ seq, cols: last.cols, rows: last.rows, data: this.mirror.serialize(), sizeEventId: last.id });
      });
    });
  }

  /** The visible screen as plain text, trailing blanks trimmed. Reflects output parsed so far. */
  screenText(): string {
    return this.mirror.screenText();
  }

  /** Ends the shell and releases the mirror; nothing is reported after this. */
  dispose(): void {
    if (this.disposed) return;
    // node-pty releases its output worker only after reading the end of the stream, which a paused pty never does.
    if (this.pauses.size > 0 && this.exitCodeValue === undefined) {
      try {
        this.pty.resume();
      } catch (error) {
        log.warn('could not resume a paused pty before ending it', error);
      }
    }
    this.disposed = true;
    this.kill();
    for (const subscription of this.ptySubscriptions.splice(0)) subscription.dispose();
    this.job?.close();
    this.resolveReady();
    this.held = [];
    this.outputListeners.clear();
    this.exitListeners.clear();
    this.sizeListeners.clear();
    this.mirror.dispose();
  }

  private async runResizes(): Promise<void> {
    try {
      await this.readyPromise;
      while (!this.disposed && this.exitCodeValue === undefined && !sameSize(this.wanted, this.size)) {
        // Output still in flight (such as the echo of a key typed just now) was produced for the old size.
        // It is routed as usual meanwhile, so it can still realign the previous resize.
        await this.waitForQuiet();
        const next = this.wanted;
        if (this.disposed || this.exitCodeValue !== undefined || sameSize(next, this.size)) break;
        await this.exclusive(() => this.resizeOnce(next));
      }
    } catch (error) {
      log.error('resize failed', error);
    } finally {
      this.resizeRun = undefined; // cleared before any caller resumes, so none can miss a run
    }
  }

  /** Runs one output-holding step (a resize or a realignment) after the previous one has finished. */
  private exclusive(step: () => Promise<void>): Promise<void> {
    const run = this.holdChain.then(step);
    this.holdChain = run.catch(() => undefined);
    return run;
  }

  private async resizeOnce(next: TerminalSize): Promise<void> {
    if (this.disposed || this.exitCodeValue !== undefined) return;
    this.hold();
    try {
      this.resizePty(next); // the boundary: output from here on is for the new size
      await this.mirror.flush(); // everything before the boundary is parsed
      await this.closeOpenSequence();
      if (this.disposed) return;
      const { cursor, alternateScreen } = this.mirror;
      const prelude = conptyResizePrelude({ ...this.size, cursor, alternateScreen }, next);
      // The prelude follows the measured row rule, but ConPTY reflows its whole buffer on a width change
      // and its row rule shifts after one, so every resize is checked against ConPTY's next cursor position.
      this.realignPending ||= !alternateScreen;
      if (prelude === '') return this.applySize(next);
      await new Promise<void>((resolve) => {
        this.processOutput(prelude, () => {
          this.applySize(next);
          resolve();
        });
      });
    } finally {
      this.release(); // held output may carry the position a realignment waits for
    }
  }

  /** Waits for RESIZE_QUIET_MS without input or output (at most RESIZE_QUIET_MAX_MS). */
  private async waitForQuiet(): Promise<void> {
    const deadline = Date.now() + RESIZE_QUIET_MAX_MS;
    for (;;) {
      const wait = Math.min(this.lastIoAt + RESIZE_QUIET_MS, deadline) - Date.now();
      if (wait <= 0 || this.disposed) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /**
   * Shifts the rows so the cursor's row matches ConPTY's, before the output that
   * carries ConPTY's cursor position is applied. Only when that position is in the
   * cursor's column: otherwise ConPTY is writing elsewhere and proves nothing.
   */
  private async realign(position: { row: number; col: number }): Promise<void> {
    try {
      await this.mirror.flush(); // everything before the position is parsed
      if (this.disposed) return;
      const { cursor, alternateScreen } = this.mirror;
      if (alternateScreen || position.col !== cursor.x) return;
      const correction = shiftRows({ ...this.mirror.size, cursor, alternateScreen }, cursor.y - position.row);
      if (correction !== '') this.processOutput(correction);
    } finally {
      this.release();
    }
  }

  private hold(): void {
    this.holding = true;
    this.setPaused('resize', true);
  }

  /** Lets held output through in order; a chunk that starts another hold stops the rest. */
  private release(): void {
    this.holding = false;
    this.setPaused('resize', false);
    while (!this.holding && !this.disposed && this.held.length > 0) this.route(this.held.shift()!);
    if (this.disposed) this.held = [];
    if (!this.holding && this.exitPending !== undefined) this.finishExit(this.exitPending);
  }

  /**
   * A chunk can end inside an escape sequence. The prelude's ESC would abort it
   * and its rest would print as text, so the held output that finishes it is
   * applied first. If it has not arrived, the pty runs a little longer for it.
   */
  private async closeOpenSequence(): Promise<void> {
    const deadline = Date.now() + OPEN_SEQUENCE_WAIT_MS;
    while (!this.disposed) {
      const end = this.ring.end;
      const cut = snapshotCut(this.ring, end);
      if (cut === end) return;
      const open = this.ring.read(cut, end - cut);
      const held = Buffer.from(this.held.join(''), 'utf8');
      const finish = open === undefined ? 0 : openSequenceRemainder(open, held);
      if (finish !== undefined) {
        this.held = held.length > finish ? [held.subarray(finish).toString('utf8')] : [];
        if (finish > 0) this.processOutput(held.subarray(0, finish).toString('utf8'));
        await this.mirror.flush();
        return;
      }
      if (Date.now() >= deadline || this.exitCodeValue !== undefined || this.exitPending !== undefined) return;
      // Let the rest of the sequence arrive; it is held like everything after the boundary.
      this.setPaused('resize', false);
      await new Promise((resolve) => setTimeout(resolve, OPEN_SEQUENCE_POLL_MS));
      this.setPaused('resize', true);
    }
  }

  /** Resizes the mirror and records where the new size starts, in one step. */
  private applySize(next: TerminalSize): void {
    if (this.disposed) return;
    this.mirror.resize(next.cols, next.rows);
    const event: SizeEvent = { id: this.sizeLog.at(-1)!.id + 1, seq: this.ring.end, ...next };
    this.sizeLog.push(event);
    this.pruneSizeLog();
    this.sizeListeners.emit(event);
  }

  /** Keeps the events a retained offset can need: those inside the ring and the one in effect at its start. */
  private pruneSizeLog(): void {
    const start = this.ring.start;
    let drop = 0;
    while (drop < this.sizeLog.length - 1 && this.sizeLog[drop + 1]!.seq <= start) drop++;
    drop = Math.max(drop, this.sizeLog.length - MAX_SIZE_EVENTS);
    if (drop > 0) this.sizeLog.splice(0, drop);
  }

  private writeToPty(data: string): void {
    if (this.exitCodeValue !== undefined || this.disposed) return;
    this.lastIoAt = Date.now();
    this.pty.write(data);
  }

  private resizePty(size: TerminalSize): void {
    try {
      this.pty.resize(size.cols, size.rows);
    } catch (error) {
      // The shell can exit between our check and the call; resizing it then is moot.
      if (!/already exited/.test((error as Error).message)) throw error;
    }
  }

  private handleOutput(text: string): void {
    this.lastIoAt = Date.now();
    if (!this.readyScheduled) this.scheduleReady();
    if (this.holding) this.held.push(text);
    else this.route(text);
  }

  /** Applies a chunk of pty output, unless it carries the cursor position a realignment waits for. */
  private route(text: string): void {
    const position = this.realignPending ? firstCursorPosition(text) : undefined;
    if (position === undefined) return this.processOutput(text);
    this.realignPending = false;
    if (position.index > 0) this.processOutput(text.slice(0, position.index));
    this.hold();
    this.held.unshift(text.slice(position.index));
    void this.exclusive(() => this.realign(position));
  }

  private processOutput(text: string, parsed?: () => void): void {
    const data = Buffer.from(text, 'utf8');
    const chunk: OutputChunk = { seq: this.ring.end, data };
    this.ring.append(data);
    // Pause the shell rather than let the mirror's queue grow without bound.
    this.pendingMirrorBytes += data.length;
    if (this.pendingMirrorBytes > this.watermarks.high) this.setPaused('mirror', true);
    this.mirror.write(text, () => {
      this.mirrorParsed(data.length);
      parsed?.();
    });
    this.outputListeners.emit(chunk);
  }

  /** Our data listener runs before node-pty's own "ready" handler for the same chunk. */
  private scheduleReady(): void {
    this.readyScheduled = true;
    setImmediate(() => this.resolveReady());
  }

  private mirrorParsed(bytes: number): void {
    this.pendingMirrorBytes -= bytes;
    if (this.pendingMirrorBytes < this.watermarks.low) this.setPaused('mirror', false);
  }

  private setPaused(reason: PauseReason, paused: boolean): void {
    const before = this.pauses.size > 0;
    if (paused) this.pauses.add(reason);
    else this.pauses.delete(reason);
    const after = this.pauses.size > 0;
    if (before === after || this.exitCodeValue !== undefined || this.disposed) return;
    if (after) this.pty.pause();
    else this.pty.resume();
  }

  private handleExit(code: number): void {
    if (this.exitCodeValue !== undefined) return;
    // Output held by a resize still belongs before the exit.
    if (this.holding) this.exitPending = code;
    else this.finishExit(code);
  }

  private finishExit(code: number): void {
    if (this.exitCodeValue !== undefined) return;
    this.exitPending = undefined;
    this.exitCodeValue = code;
    // Without kill-on-close, background processes (start /b) keep running after a normal exit.
    this.job?.close();
    this.resolveReady(); // a resize waiting for the first output gives up
    this.exitListeners.emit(code);
    this.exitListeners.clear();
  }
}

/** Puts the shell into its own job so kill() can end the whole process tree. */
function joinNewJob(pid: number): { job?: ProcessJob; jobError?: Error } {
  let job: ProcessJob | undefined;
  try {
    job = createProcessJob({ killOnClose: false });
    job.assign(pid);
    return { job };
  } catch (error) {
    job?.close();
    return { jobError: error instanceof Error ? error : new Error(String(error)) };
  }
}

function watermarks(options: SessionOptions): { high: number; low: number } {
  const high = options.mirrorHighWatermark ?? DEFAULT_HIGH_WATERMARK;
  return { high, low: Math.min(options.mirrorLowWatermark ?? DEFAULT_LOW_WATERMARK, high) };
}

function sameSize(a: TerminalSize, b: TerminalSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

export function clampSize(cols: number, rows: number): TerminalSize {
  return { cols: clampDimension(cols, MIN_COLS, MAX_COLS), rows: clampDimension(rows, MIN_ROWS, MAX_ROWS) };
}

function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value) || min));
}
