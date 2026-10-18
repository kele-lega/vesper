import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { HostApiError, SESSION_ID_PATTERN, type CreateOptions, type HostEvent, type SessionInfo } from '@vesper/protocol';
import { DEFAULT_TIMING, HostedSession, isDirectory, type SessionContext, type SessionTiming } from './hosted-session.js';
import { HookServer } from './hook-server.js';
import { launcherFor } from './launcher.js';
import { Listeners, log } from './log.js';
import { clampSize } from './session.js';
import type { ShellPaths } from './shells.js';
import { SessionStore } from './store.js';

export interface HostConfig {
  /** Holds host.db and one directory per session. */
  dataDir: string;
  shellPaths: ShellPaths;
  scrollback?: number;
  timing?: Partial<SessionTiming>;
  ringCapacity?: number;
  window?: number;
  /** Where vesper-launch is built for "normal" sessions; without it an elevated host refuses them. */
  binDir?: string;
  /** Why "normal" sessions must be refused right now, e.g. the home could not be protected. */
  normalBlocked?: () => string | undefined;
}

const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_SIZE = { cols: 120, rows: 30 };

/** Every session this host runs, and the events web clients follow them by. */
export class Host {
  private readonly store: SessionStore;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly events = new Listeners<HostEvent>('host event');
  private readonly ctx: SessionContext;

  constructor(config: HostConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.store = new SessionStore(join(config.dataDir, 'host.db'));
    this.ctx = {
      store: this.store,
      sessionsDir: join(config.dataDir, 'sessions'),
      shellPaths: config.shellPaths,
      scrollback: config.scrollback ?? DEFAULT_SCROLLBACK,
      timing: { ...DEFAULT_TIMING, ...config.timing },
      ...(config.ringCapacity ? { ringCapacity: config.ringCapacity } : {}),
      ...(config.window ? { window: config.window } : {}),
      onChange: (session) => this.events.emit({ event: 'session', session: session.info() }),
      onNotice: (session, notice) => this.events.emit({ event: 'notice', session: session.id, ...notice, at: Date.now() }),
      // Always set: on an elevated host without a bin folder, "normal" must fail, not run as admin.
      launcher: launcherFor(config.binDir, config.shellPaths.systemRoot, config.normalBlocked),
    };
  }

  /** Starts the agent hook receiver; agents created before (or if this fails) follow their title only. */
  async startHooks(): Promise<void> {
    const hooks = new HookServer();
    try {
      await hooks.start();
      this.ctx.hooks = hooks;
    } catch (error) {
      log.warn('could not start the agent hook receiver; agent states come from window titles only', error);
    }
  }

  /** Brings back every recorded session; a running one restarts below its history. */
  async restore(): Promise<void> {
    const records = this.store.list();
    for (const record of records) {
      try {
        this.sessions.set(record.id, await HostedSession.restore(this.ctx, record));
      } catch (error) {
        log.error(`could not restore session ${record.id}`, error);
      }
    }
    await this.sweepOrphans(new Set(records.map((record) => record.id)));
  }

  /** Deletes the directories of sessions that were removed but whose files were busy at the time. */
  private async sweepOrphans(known: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.ctx.sessionsDir);
    } catch {
      return; // no sessions yet
    }
    for (const name of names) {
      if (known.has(name) || !SESSION_ID_PATTERN.test(name)) continue;
      await rm(join(this.ctx.sessionsDir, name), { recursive: true, force: true }).catch((error: unknown) =>
        log.warn(`could not delete the leftover files of session ${name}`, error),
      );
    }
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    return this.events.add(listener);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  get(id: string): HostedSession | undefined {
    return this.sessions.get(id);
  }

  create(options: CreateOptions): SessionInfo {
    const cwd = options.cwd ?? homedir();
    if (!isAbsolute(cwd) || !isDirectory(cwd)) throw new HostApiError('bad_cwd', `not a directory: ${cwd}`);
    const size = clampSize(options.cols ?? DEFAULT_SIZE.cols, options.rows ?? DEFAULT_SIZE.rows);
    const id = randomBytes(9).toString('base64url');
    const launch = 'command' in options ? { shell: null, command: options.command } : { shell: options.shell, command: null };
    let session: HostedSession;
    try {
      const elevation = options.elevation ?? 'admin';
      session = HostedSession.create(this.ctx, { id, ...launch, cwd, ...size, elevation, ...(options.title ? { title: options.title } : {}) });
    } catch (error) {
      const what = launch.command?.label ?? launch.shell;
      throw new HostApiError('spawn_failed', `could not start ${what}: ${(error as Error).message}`);
    }
    this.sessions.set(id, session);
    const info = session.info();
    this.events.emit({ event: 'session', session: info });
    return info;
  }

  /** Starts an exited session's shell or command again, below its history. */
  restart(id: string): Promise<SessionInfo> {
    return this.require(id).restart();
  }

  kill(id: string): void {
    this.require(id).kill();
  }

  remove(id: string): void {
    const session = this.require(id);
    try {
      session.remove();
    } finally {
      // Whatever failed, the session is gone from this host and its clients.
      this.sessions.delete(id);
      this.events.emit({ event: 'removed', session: id });
    }
  }

  /** Checkpoints every session and ends the shells; their records stay "running" so the next host restarts them. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.shutdown()));
    await this.ctx.hooks?.close();
    this.sessions.clear();
    this.events.clear();
    this.store.close();
  }

  private require(id: string): HostedSession {
    const session = this.sessions.get(id);
    if (!session) throw new HostApiError('not_found', `no session ${id}`);
    return session;
  }
}
