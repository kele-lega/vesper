import { Buffer } from 'node:buffer';
import { release } from 'node:os';
import serializeAddon from '@xterm/addon-serialize';
import type { SerializeAddon } from '@xterm/addon-serialize';
import unicode11Addon from '@xterm/addon-unicode11';
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { answerColourQueries } from './colour-queries.js';
import { buildEnv, type LaunchSpec } from './shells.js';
import { createProcessJob, type ProcessJob } from './windows-job.js';

export interface SessionOptions {
  launch: LaunchSpec;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  scrollback?: number;
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

/** Serialized screen and scrollback, exactly as of output offset seq. */
export interface Snapshot {
  seq: number;
  cols: number;
  rows: number;
  data: string;
}

const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_HIGH_WATERMARK = 4 << 20;
const DEFAULT_LOW_WATERMARK = 1 << 20;
const MIN_COLS = 2; // xterm.js does not go below 2 columns
const MIN_ROWS = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
const WINDOWS_BUILD = Number(release().split('.')[2] ?? 0);
const TERMINAL_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };

/**
 * One ConPTY session plus a headless xterm mirror of its screen.
 *
 * The mirror is the only party that answers terminal queries (DA1, cursor
 * position, colours, ...). The bundled ConPTY waits for a DA1 reply at startup, and
 * with several browsers attached, browser replies would arrive more than once.
 */
export class PtySession {
  static spawn(options: SessionOptions): PtySession {
    const env = buildEnv(process.env, TERMINAL_ENV, options.launch.env, options.env ?? {});
    const cols = clampDimension(options.cols, MIN_COLS, MAX_COLS);
    const rows = clampDimension(options.rows, MIN_ROWS, MAX_ROWS);
    const pty = nodePty.spawn(options.launch.file, options.launch.args, {
      name: TERMINAL_ENV.TERM,
      cols,
      rows,
      cwd: options.cwd,
      env,
      useConpty: true,
      // The ConPTY bundled with node-pty: newer than Windows 10's built-in one and
      // does not leak a conhost.exe per exited shell (microsoft/node-pty#965).
      useConptyDll: true,
    });
    try {
      const { terminal, serializer } = createMirror(cols, rows, options.scrollback ?? DEFAULT_SCROLLBACK);
      const { job, jobError } = process.platform === 'win32' ? joinNewJob(pty.pid) : {};
      return new PtySession(pty, terminal, serializer, job, jobError, watermarks(options));
    } catch (error) {
      pty.kill(); // never leave a shell running that nothing owns
      throw error;
    }
  }

  private seqValue = 0;
  private exitCodeValue: number | undefined;
  private pendingMirrorBytes = 0;
  private paused = false;
  /** Set after the first output; node-pty defers resize and kill until then. */
  private ready = false;
  private readyScheduled = false;
  private pendingSize: { cols: number; rows: number } | undefined;
  private readonly outputListeners = new Set<(chunk: OutputChunk) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();

  private constructor(
    private readonly pty: IPty,
    private readonly mirror: Terminal,
    private readonly serializer: SerializeAddon,
    private readonly job: ProcessJob | undefined,
    /** Why the shell runs without a job (it may have exited already); kill then only ends the shell. */
    readonly jobError: Error | undefined,
    private readonly watermarks: { high: number; low: number },
  ) {
    mirror.onData((reply) => this.writeToPty(reply));
    answerColourQueries(mirror.parser, (reply) => this.writeToPty(reply));
    pty.onData((text) => this.handleOutput(text));
    // node-pty can report the exit before its native thread has stored the code.
    pty.onExit(({ exitCode }) => this.handleExit(exitCode ?? -1));
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Total bytes of output so far; the seq of the next chunk. */
  get seq(): number {
    return this.seqValue;
  }

  get exitCode(): number | undefined {
    return this.exitCodeValue;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.mirror.cols, rows: this.mirror.rows };
  }

  onOutput(listener: (chunk: OutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** Calls the listener once with the exit code, also when the session has already exited. */
  onExit(listener: (code: number) => void): () => void {
    const code = this.exitCodeValue;
    if (code !== undefined) {
      queueMicrotask(() => listener(code));
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(input: string): void {
    this.writeToPty(input);
  }

  resize(cols: number, rows: number): void {
    if (this.exitCodeValue !== undefined) return;
    const next = { cols: clampDimension(cols, MIN_COLS, MAX_COLS), rows: clampDimension(rows, MIN_ROWS, MAX_ROWS) };
    this.mirror.resize(next.cols, next.rows);
    // node-pty queues calls made before the first output and replays them later; a queued
    // resize that runs after the shell exited throws where no caller can catch it.
    if (this.ready) this.resizePty(next);
    else this.pendingSize = next;
  }

  /** Ends the shell and every process it started, detached ones included. */
  kill(): void {
    if (this.exitCodeValue !== undefined) return;
    try {
      this.job?.terminate(1);
    } catch (error) {
      console.warn(`could not end the process tree of pid ${this.pty.pid}`, error);
    } finally {
      this.pty.kill();
    }
  }

  snapshot(): Promise<Snapshot> {
    const seq = this.seqValue;
    return new Promise((resolve) => {
      // The callback runs right after every chunk counted in seq has been parsed and
      // before any later chunk is, so serializing inside it matches seq exactly.
      this.mirror.write('', () => {
        resolve({ seq, cols: this.mirror.cols, rows: this.mirror.rows, data: this.serializer.serialize() });
      });
    });
  }

  /** The visible screen as plain text, trailing blanks trimmed. Reflects output parsed so far. */
  screenText(): string {
    const buffer = this.mirror.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.mirror.rows; row++) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    }
    return lines.join('\n').trimEnd();
  }

  private writeToPty(data: string): void {
    if (this.exitCodeValue !== undefined) return;
    this.pty.write(data);
  }

  private resizePty(size: { cols: number; rows: number }): void {
    try {
      this.pty.resize(size.cols, size.rows);
    } catch (error) {
      // The shell can exit between our check and the call; resizing it then is moot.
      if (!/already exited/.test((error as Error).message)) throw error;
    }
  }

  private handleOutput(text: string): void {
    if (!this.readyScheduled) {
      // Our data listener runs before node-pty's own "ready" handler for the same chunk,
      // so wait one turn of the event loop before calling into the pty directly.
      this.readyScheduled = true;
      setImmediate(() => {
        this.ready = true;
        const pending = this.pendingSize;
        this.pendingSize = undefined;
        if (pending && this.exitCodeValue === undefined) this.resizePty(pending);
      });
    }
    const data = Buffer.from(text, 'utf8');
    const chunk: OutputChunk = { seq: this.seqValue, data };
    this.seqValue += data.length;
    // Pause the shell rather than let the mirror's queue grow without bound.
    this.pendingMirrorBytes += data.length;
    if (!this.paused && this.pendingMirrorBytes > this.watermarks.high) {
      this.paused = true;
      this.pty.pause();
    }
    this.mirror.write(text, () => this.mirrorParsed(data.length));
    emit(this.outputListeners, chunk, 'output');
  }

  private mirrorParsed(bytes: number): void {
    this.pendingMirrorBytes -= bytes;
    if (!this.paused || this.pendingMirrorBytes >= this.watermarks.low) return;
    this.paused = false;
    if (this.exitCodeValue === undefined) this.pty.resume();
  }

  private handleExit(code: number): void {
    if (this.exitCodeValue !== undefined) return;
    this.exitCodeValue = code;
    // Without kill-on-close, background processes (start /b) keep running after a normal exit.
    this.job?.close();
    emit(this.exitListeners, code, 'exit');
    this.exitListeners.clear();
  }
}

function createMirror(cols: number, rows: number, scrollback: number): { terminal: Terminal; serializer: SerializeAddon } {
  const terminal = new xtermHeadless.Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    // The same ConPTY handling and width table as the browser, so snapshots line up with what it shows.
    windowsPty: { backend: 'conpty', buildNumber: WINDOWS_BUILD },
  });
  const serializer = new serializeAddon.SerializeAddon();
  terminal.loadAddon(serializer);
  terminal.loadAddon(new unicode11Addon.Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  return { terminal, serializer };
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

function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value) || min));
}

/** Calls every listener; one that throws is logged and does not stop the rest. */
function emit<T>(listeners: Set<(value: T) => void>, value: T, kind: string): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      console.error(`session ${kind} listener failed`, error);
    }
  }
}
