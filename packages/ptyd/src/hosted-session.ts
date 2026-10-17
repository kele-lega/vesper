import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostApiError, type CloseReason, type Elevation, type LaunchCommand, type ResumePoint, type SessionInfo, type ShellKind } from '@vesper/protocol';
import { Attachment, type AttachmentHooks, type AttachPeer, type OutputSource } from './attachment.js';
import { log } from './log.js';
import type { ScreenMirror } from './mirror.js';
import { NoticeLimiter, type Notice } from './notify-osc.js';
import { SessionFiles } from './persistence.js';
import { appendEndMarker, appendRestoreMarker, loadScreen, type RestoredScreen } from './restore.js';
import { PtySession, type OutputChunk, type SizeEvent, type Snapshot, type TerminalSize } from './session.js';
import { commandLaunchSpec, gitRootOf, msysToWindowsPath, shellLaunchSpec, throughLauncher, type LaunchSpec, type ShellPaths } from './shells.js';
import { SizeArbiter } from './sizing.js';
import type { SessionChanges, SessionRecord, SessionStore } from './store.js';

const SHELL_LABELS: Record<ShellKind, string> = { powershell: 'Windows PowerShell', cmd: '命令提示符', gitbash: 'Git Bash' };
const LOG_FLUSH_BYTES = 64 * 1024;
const MAX_OSC_TITLE = 256;
const FOCUS_REPORTS = /^(?:\x1b\[[IO])+$/;
const NOTICE_BURST = 5;
const NOTICE_INTERVAL_MS = 6000;

export interface SessionTiming {
  /** How often queued output is appended to the log. */
  flushMs: number;
  /** How often a session with new output saves a checkpoint. */
  checkpointMs: number;
  /** Output since the last checkpoint that triggers one right away. */
  checkpointBytes: number;
  /** Title and directory changes are batched this long before saving. */
  metaMs: number;
}

export const DEFAULT_TIMING: SessionTiming = {
  flushMs: 1000,
  checkpointMs: 30_000,
  checkpointBytes: 8 << 20,
  metaMs: 200,
};

export interface SessionContext {
  store: SessionStore;
  sessionsDir: string;
  shellPaths: ShellPaths;
  scrollback: number;
  timing: SessionTiming;
  ringCapacity?: number;
  window?: number;
  onChange(session: HostedSession): void;
  onNotice(session: HostedSession, notice: Notice): void;
  /** The launcher for "normal" sessions; undefined when the host's own token is normal already. */
  launcher?: () => string | undefined;
}

export interface NewSession {
  id: string;
  /** Exactly one of shell and command is set. */
  shell: ShellKind | null;
  command: LaunchCommand | null;
  cwd: string;
  cols: number;
  rows: number;
  title?: string;
  elevation: Elevation;
}

/** The restored screen of a session that exited before the host restarted. */
class StaticSource implements OutputSource {
  constructor(
    private readonly mirror: ScreenMirror,
    readonly seq: number,
    readonly exitCode: number,
  ) {}

  read(from: number): Uint8Array | undefined {
    return from === this.seq ? new Uint8Array(0) : undefined;
  }

  async snapshot(): Promise<Snapshot> {
    await this.mirror.flush();
    return { seq: this.seq, ...this.mirror.size, data: this.mirror.serialize(), sizeEventId: 0 };
  }

  sizeAt(): SizeEvent {
    return { id: 0, seq: 0, ...this.mirror.size };
  }

  sizeEventsAfter(): SizeEvent[] {
    return [];
  }

  onOutput(): () => void {
    return () => undefined;
  }

  onSize(): () => void {
    return () => undefined;
  }

  onExit(listener: (code: number) => void): () => void {
    queueMicrotask(() => listener(this.exitCode));
    return () => undefined;
  }
}

/**
 * A session as the host keeps it: the live shell (or the restored screen of one
 * that exited), its attached clients, its log and checkpoints, and its record.
 */
export class HostedSession {
  /** Starts a new shell and records it. */
  static create(ctx: SessionContext, spec: NewSession): HostedSession {
    const record: SessionRecord = {
      id: spec.id,
      shell: spec.shell,
      command: spec.command,
      title: spec.title ?? '',
      oscTitle: '',
      cwd: spec.cwd,
      lastCwd: spec.cwd,
      status: 'running',
      exitCode: null,
      inc: 1,
      cols: spec.cols,
      rows: spec.rows,
      createdAt: Date.now(),
      exitedAt: null,
      elevation: spec.elevation,
    };
    const session = new HostedSession(ctx, record, new SessionFiles(join(ctx.sessionsDir, spec.id)));
    ctx.store.insert(record);
    try {
      session.goLive(spec.cwd, undefined);
    } catch (error) {
      ctx.store.delete(spec.id);
      void session.files.remove().catch(() => undefined);
      throw error;
    }
    return session;
  }

  /**
   * Brings a recorded session back. A running shell restarts in its last directory below
   * its history; a running command (an agent, a dev server) is shown as ended instead,
   * since starting it again unasked could repeat its work. restart() starts either again.
   */
  static async restore(ctx: SessionContext, record: SessionRecord): Promise<HostedSession> {
    const session = new HostedSession(ctx, record, new SessionFiles(join(ctx.sessionsDir, record.id)));
    const screen = await loadScreen(session.files, record, ctx.scrollback);
    if (record.status === 'exited') {
      session.showExited(screen, record.exitCode ?? -1);
    } else if (record.command) {
      await session.endInterrupted(screen);
    } else {
      if (screen.hasHistory) await appendRestoreMarker(screen.mirror, new Date());
      session.startOver(screen);
    }
    return session;
  }

  /** Starts an exited session's shell or command again, below its history; attached clients must reattach. */
  async restart(): Promise<SessionInfo> {
    if (this.running || this.restarting) throw new HostApiError('bad_request', `session ${this.id} is still running`);
    this.restarting = true;
    try {
      await this.checkpointRun; // the exit checkpoint, so the screen below is complete
      this.files.flush();
      const screen = await loadScreen(this.files, this.record, this.ctx.scrollback);
      await appendRestoreMarker(screen.mirror, '重新启动');
      if (this.ended) {
        screen.mirror.dispose();
        throw new HostApiError('not_found', `session ${this.id} was removed`);
      }
      for (const attachment of [...this.attachments]) this.detach(attachment, 'restarted');
      const previous = { pty: this.pty, mirror: this.staticMirror };
      this.pty = undefined;
      this.staticMirror = undefined;
      this.startOver(screen);
      previous.pty?.dispose();
      previous.mirror?.dispose();
      this.ctx.onChange(this);
      return this.info();
    } finally {
      this.restarting = false;
    }
  }

  private source!: OutputSource;
  private pty: PtySession | undefined;
  private staticMirror: ScreenMirror | undefined;
  private inc: number;
  private ended = false;
  private exitCheckpointDone = false;
  private savedThrough = -1;
  /** Output offset the newest checkpoint round started from; byte-triggered rounds count from here. */
  private checkpointFrom = 0;
  private checkpointRun: Promise<void> | undefined;
  private checkpointAgain = false;
  private readonly attachments = new Set<Attachment>();
  private readonly sizes = new SizeArbiter<Attachment>();
  private pendingMeta: SessionChanges = {};
  private metaTimer: NodeJS.Timeout | undefined;
  private readonly notices = new NoticeLimiter(NOTICE_BURST, NOTICE_INTERVAL_MS);
  private restarting = false;
  private readonly intervals: NodeJS.Timeout[] = [];
  private readonly hooks: AttachmentHooks = {
    input: (attachment, text) => this.handleInput(attachment, text),
    resize: (attachment, size) => this.handleResize(attachment, size),
  };

  private constructor(
    private readonly ctx: SessionContext,
    private record: SessionRecord,
    private readonly files: SessionFiles,
  ) {
    this.inc = record.inc;
  }

  get id(): string {
    return this.record.id;
  }

  get running(): boolean {
    return this.pty !== undefined && this.pty.exitCode === undefined;
  }

  info(): SessionInfo {
    const { id, shell, command, title, oscTitle, lastCwd, status, exitCode, createdAt } = this.record;
    return {
      id,
      shell,
      title: title || oscTitle || command?.label || (shell ? SHELL_LABELS[shell] : ''),
      cwd: lastCwd,
      status,
      exitCode,
      inc: this.inc,
      ...this.screenSize(),
      createdAt,
      attached: this.attachments.size,
      elevation: this.record.elevation,
    };
  }

  attach(peer: AttachPeer, options: { resume?: ResumePoint; size?: TerminalSize }): Attachment {
    const attachment = new Attachment(this.source, peer, this.hooks, {
      inc: this.inc,
      ...(options.resume ? { resume: options.resume } : {}),
      ...(this.ctx.window ? { window: this.ctx.window } : {}),
    });
    this.attachments.add(attachment);
    const size = this.sizes.attach(attachment, options.size);
    if (size) this.applySize(size);
    attachment.start();
    this.ctx.onChange(this);
    return attachment;
  }

  detach(attachment: Attachment, reason?: CloseReason): void {
    if (!this.attachments.delete(attachment)) return;
    attachment.close(reason);
    this.sizes.detach(attachment);
    this.ctx.onChange(this);
  }

  /** Ends the shell and its process tree; the session stays, showing its last screen. */
  kill(): void {
    this.pty?.kill();
  }

  /**
   * Ends the shell if needed and deletes the session. The record goes first: files
   * held open by a virus scanner or an editor must not bring the session back on
   * the next start, so their removal is only attempted (Host.restore sweeps leftovers).
   */
  remove(): void {
    this.end('removed');
    this.ctx.store.delete(this.id);
    this.pty?.dispose();
    this.staticMirror?.dispose();
    this.files.remove().catch((error: unknown) => log.warn(`could not delete the files of session ${this.id}`, error));
  }

  /** Saves everything so the next host restarts the shell, then ends it. */
  async shutdown(): Promise<void> {
    this.stopTimers();
    if (this.pty && !this.exitCheckpointDone) await this.checkpoint();
    this.files.flush();
    this.saveMeta(); // after the checkpoint: a title or directory may have changed meanwhile
    this.end('shutdown');
    this.pty?.dispose();
    this.staticMirror?.dispose();
  }

  private end(reason: CloseReason): void {
    this.ended = true;
    this.stopTimers();
    clearTimeout(this.metaTimer);
    this.metaTimer = undefined;
    for (const attachment of [...this.attachments]) attachment.close(reason);
    this.attachments.clear();
  }

  private handleInput(attachment: Attachment, text: string): void {
    // ConPTY turns on focus reporting (DECSET 1004), so a window that merely gains or
    // loses focus sends CSI I / CSI O. Only real typing makes a device the size driver.
    if (!FOCUS_REPORTS.test(text)) {
      const size = this.sizes.input(attachment);
      if (size) this.applySize(size);
    }
    this.pty?.write(text);
  }

  private handleResize(attachment: Attachment, size: TerminalSize): void {
    const next = this.sizes.resize(attachment, size);
    if (next) this.applySize(next);
  }

  private applySize(wanted: TerminalSize): void {
    // The pty reports the change in stream order (see goLive), which also tells the clients.
    if (this.running) this.pty?.resize(wanted.cols, wanted.rows);
  }

  private launchSpec(cwdNonce: string, cwd: string): LaunchSpec {
    const { shell, command, elevation } = this.record;
    let spec: LaunchSpec;
    if (command) spec = commandLaunchSpec(command, this.ctx.shellPaths.systemRoot);
    else if (shell) spec = shellLaunchSpec(shell, this.ctx.shellPaths, { cwdNonce });
    else throw new Error('the session has neither a shell nor a command');
    // A launcher that cannot be built (or is blocked) fails the start: never fall back to the admin token.
    const launcher = elevation === 'normal' ? this.ctx.launcher?.() : undefined;
    return launcher ? throughLauncher(spec, launcher, cwd) : spec;
  }

  private goLive(cwd: string, mirror: ScreenMirror | undefined): void {
    const { cols, rows, id } = this.record;
    // A command has no prompt hook, so no report can carry this nonce and its directory stays put.
    const cwdNonce = randomBytes(12).toString('base64url');
    const pty = PtySession.spawn({
      launch: this.launchSpec(cwdNonce, cwd),
      cwd,
      cols,
      rows,
      env: { VESPER_SID: id },
      scrollback: this.ctx.scrollback,
      mirror,
      ...(this.ctx.ringCapacity ? { ringCapacity: this.ctx.ringCapacity } : {}),
    });
    if (pty.jobError) log.warn(`session ${id} runs without a job object; kill ends only the shell`, pty.jobError);
    this.pty = pty;
    this.source = pty;
    this.inc = this.record.inc;
    pty.onOutput((chunk) => this.logOutput(chunk));
    pty.onSize(({ cols, rows }) => this.changeMeta({ cols, rows }));
    pty.onExit((code) => void this.handleExit(code));
    pty.mirror.onTitle((title) => this.changeMeta({ oscTitle: cleanTitle(title) }));
    pty.mirror.onCwd(({ nonce, path }) => {
      // Only this shell's prompt hook knows the nonce; other output can claim any directory.
      const local = nonce === cwdNonce ? localDirectory(this.windowsPath(path)) : undefined;
      if (local !== undefined) this.changeMeta({ lastCwd: local });
    });
    // Subscribed after a restore replayed the old output, so its notifications are not raised again.
    pty.mirror.onNotice((notice) => {
      if (this.notices.allow(performance.now())) this.ctx.onNotice(this, notice);
    });
    const { flushMs, checkpointMs } = this.ctx.timing;
    this.intervals.push(setInterval(() => this.files.flush(), flushMs).unref());
    this.intervals.push(setInterval(() => void this.checkpointIfChanged(), checkpointMs).unref());
  }

  /**
   * Starts the program again on a restored screen, as a new incarnation. If it cannot
   * start, the screen says why and the session shows as exited; in memory only for a
   * shell, whose record still says "running" so the next host start tries again.
   */
  private startOver(screen: RestoredScreen): void {
    const inc = Math.max(this.record.inc, screen.inc) + 1;
    this.files.writeCheckpoint({ inc, seq: 0, ...screen.mirror.size, data: screen.mirror.serialize(), savedAt: Date.now() });
    this.persist({ inc, status: 'running', exitCode: null, exitedAt: null });
    this.exitCheckpointDone = false;
    this.savedThrough = -1;
    this.checkpointFrom = 0;
    try {
      this.goLive(this.restartCwd(), screen.mirror);
    } catch (error) {
      log.error(`could not start session ${this.id} again`, error);
      screen.mirror.write(`\x1b[31m无法重新启动：${(error as Error).message}\x1b[0m\r\n`);
      this.showExited({ ...screen, inc, seq: 0 }, -1);
      const exited = { status: 'exited', exitCode: -1, exitedAt: Date.now() } as const;
      if (this.record.command) this.persist(exited);
      else this.patch(exited);
    }
  }

  /** A command that was running when the host stopped: its screen stays, marked as ended. */
  private async endInterrupted(screen: RestoredScreen): Promise<void> {
    await appendEndMarker(screen.mirror, 'Vesper 重启，程序已结束');
    const { inc, seq } = screen;
    this.files.writeCheckpoint({ inc, seq, ...screen.mirror.size, data: screen.mirror.serialize(), savedAt: Date.now() });
    this.showExited(screen, -1);
    this.persist({ inc, status: 'exited', exitCode: null, exitedAt: Date.now() });
  }

  private showExited(screen: RestoredScreen, exitCode: number): void {
    this.staticMirror = screen.mirror;
    this.inc = screen.inc;
    this.source = new StaticSource(screen.mirror, screen.seq, exitCode);
  }

  private logOutput(chunk: OutputChunk): void {
    if (this.ended) return;
    this.files.append(this.inc, chunk.seq, chunk.data, this.pty?.size ?? this.screenSize());
    if (this.files.bufferedBytes >= LOG_FLUSH_BYTES) this.files.flush();
    if (chunk.seq + chunk.data.length - this.checkpointFrom >= this.ctx.timing.checkpointBytes) {
      void this.checkpoint();
    }
  }

  private async handleExit(code: number): Promise<void> {
    if (this.ended) return; // removed or shutting down: the record must keep saying "running"
    this.stopTimers();
    this.changeMeta({ status: 'exited', exitCode: code, exitedAt: Date.now() });
    this.saveMeta();
    await this.checkpoint();
    this.exitCheckpointDone = true;
    this.files.flush();
  }

  private checkpointIfChanged(): Promise<void> | undefined {
    if (this.ended || !this.pty || this.pty.seq === this.savedThrough) return undefined;
    return this.checkpoint();
  }

  /**
   * One checkpoint at a time. A request while one runs makes it go round once
   * more, and every caller resolves only after the last round, so awaiting a
   * checkpoint always covers the output produced before the call.
   */
  private checkpoint(): Promise<void> {
    if (this.checkpointRun) {
      this.checkpointAgain = true;
      return this.checkpointRun;
    }
    this.checkpointRun = (async () => {
      try {
        do {
          this.checkpointAgain = false;
          await this.saveCheckpoint();
        } while (this.checkpointAgain);
      } finally {
        this.checkpointRun = undefined; // cleared before any caller resumes, so none can miss a round
      }
    })();
    return this.checkpointRun;
  }

  private async saveCheckpoint(): Promise<void> {
    const pty = this.pty;
    if (!pty) return;
    const through = pty.seq;
    this.checkpointFrom = through;
    let snapshot: Snapshot;
    try {
      snapshot = await pty.snapshot();
    } catch (error) {
      log.warn(`could not snapshot session ${this.id}`, error);
      return;
    }
    const { seq, cols, rows, data } = snapshot;
    if (this.files.writeCheckpoint({ inc: this.inc, seq, cols, rows, data, savedAt: Date.now() })) this.savedThrough = through;
  }

  private changeMeta(changes: SessionChanges): void {
    if (this.ended) return; // removed or shut down: the record is final
    this.patch(changes);
    this.pendingMeta = { ...this.pendingMeta, ...changes };
    if (this.metaTimer === undefined) {
      this.metaTimer = setTimeout(() => this.saveMeta(), this.ctx.timing.metaMs).unref();
    }
    this.ctx.onChange(this);
  }

  private patch(changes: SessionChanges): void {
    this.record = { ...this.record, ...changes };
  }

  /** Patches the record and saves it now, with anything still pending. */
  private persist(changes: SessionChanges): void {
    this.patch(changes);
    this.pendingMeta = { ...this.pendingMeta, ...changes };
    this.saveMeta();
  }

  private saveMeta(): void {
    clearTimeout(this.metaTimer);
    this.metaTimer = undefined;
    const changes = { ...this.pendingMeta, inc: this.record.inc };
    this.pendingMeta = {};
    try {
      this.ctx.store.update(this.id, changes);
    } catch (error) {
      log.error(`could not save session ${this.id}`, error);
    }
  }

  private stopTimers(): void {
    for (const interval of this.intervals.splice(0)) clearInterval(interval);
  }

  private screenSize(): TerminalSize {
    return this.pty?.size ?? this.staticMirror?.size ?? { cols: this.record.cols, rows: this.record.rows };
  }

  private windowsPath(reported: string): string {
    if (this.record.shell !== 'gitbash') return reported;
    return msysToWindowsPath(reported, gitRootOf(this.ctx.shellPaths.gitBash), tmpdir());
  }

  /**
   * The last reported directory if it still exists, else the original one, else home.
   * The reported one is checked again before the file system is touched: a row saved
   * by an older version may hold anything, and looking up \\host\share sends NTLM credentials.
   */
  private restartCwd(): string {
    const reported = localDirectory(this.record.lastCwd);
    for (const candidate of [reported, this.record.cwd]) if (candidate !== undefined && isDirectory(candidate)) return candidate;
    return homedir();
  }
}

const MAX_REPORTED_PATH = 1024;

/** A reported directory accepted only as a plain path on a local drive letter, such as C:\work. */
export function localDirectory(path: string): string | undefined {
  if (path.length > MAX_REPORTED_PATH || !/^[A-Za-z]:\\/.test(path)) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(path)) return undefined;
  return path;
}

/** Titles come from any program's output: no control or bidirectional-override characters, bounded length. */
export function cleanTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, MAX_OSC_TITLE);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
