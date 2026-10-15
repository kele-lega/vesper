import { Buffer } from 'node:buffer';
import serializeAddon from '@xterm/addon-serialize';
import type { SerializeAddon } from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { buildEnv, type LaunchSpec } from './shells.js';
import { createProcessJob, type ProcessJob } from './windows-job.js';

export interface SessionOptions {
  launch: LaunchSpec;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  scrollback?: number;
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

/** Puts the shell into its own job so kill() can end the whole process tree. */
function joinNewJob(pid: number): { job?: ProcessJob; jobError?: Error } {
  const job = createProcessJob({ killOnClose: false });
  try {
    job.assign(pid);
    return { job };
  } catch (error) {
    job.close();
    return { jobError: error instanceof Error ? error : new Error(String(error)) };
  }
}

const DEFAULT_SCROLLBACK = 5000;
const TERMINAL_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const inputDecoder = new TextDecoder();

/**
 * One ConPTY session plus a headless xterm mirror of its screen.
 *
 * The mirror is the only party that answers terminal queries (DA1, cursor
 * position, ...). The bundled ConPTY waits for a DA1 reply at startup, and with
 * several browsers attached, browser replies would arrive more than once.
 */
export class PtySession {
  static spawn(options: SessionOptions): PtySession {
    const env = buildEnv(process.env, TERMINAL_ENV, options.launch.env, options.env ?? {});
    const pty = nodePty.spawn(options.launch.file, options.launch.args, {
      name: TERMINAL_ENV.TERM,
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env,
      useConpty: true,
      // The ConPTY bundled with node-pty: newer than Windows 10's built-in one and
      // does not leak a conhost.exe per exited shell (microsoft/node-pty#965).
      useConptyDll: true,
    });
    const mirror = new xtermHeadless.Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });
    const serializer = new serializeAddon.SerializeAddon();
    mirror.loadAddon(serializer);
    const { job, jobError } = process.platform === 'win32' ? joinNewJob(pty.pid) : {};
    return new PtySession(pty, mirror, serializer, job, jobError);
  }

  private seqValue = 0;
  private exitCodeValue: number | undefined;
  private readonly outputListeners = new Set<(chunk: OutputChunk) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();

  private constructor(
    private readonly pty: IPty,
    private readonly mirror: Terminal,
    private readonly serializer: SerializeAddon,
    private readonly job: ProcessJob | undefined,
    /** Why the shell runs without a job (it may have exited already); kill then only ends the shell. */
    readonly jobError: Error | undefined,
  ) {
    mirror.onData((reply) => this.writeToPty(reply));
    pty.onData((text) => this.handleOutput(text));
    pty.onExit(({ exitCode }) => this.handleExit(exitCode));
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

  write(input: string | Uint8Array): void {
    this.writeToPty(typeof input === 'string' ? input : inputDecoder.decode(input));
  }

  resize(cols: number, rows: number): void {
    if (this.exitCodeValue !== undefined) return;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  /** Ends the shell and every process it started, detached ones included. */
  kill(): void {
    if (this.exitCodeValue !== undefined) return;
    this.job?.terminate(1);
    this.pty.kill();
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

  private handleOutput(text: string): void {
    const data = Buffer.from(text, 'utf8');
    const chunk: OutputChunk = { seq: this.seqValue, data };
    this.seqValue += data.length;
    this.mirror.write(text);
    for (const listener of this.outputListeners) listener(chunk);
  }

  private handleExit(code: number): void {
    if (this.exitCodeValue !== undefined) return;
    this.exitCodeValue = code;
    // Without kill-on-close, background processes (start /b) keep running after a normal exit.
    this.job?.close();
    for (const listener of this.exitListeners) listener(code);
    this.exitListeners.clear();
  }
}
