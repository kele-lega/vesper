import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import {
  ControlClient,
  hostPaths,
  HostClosedError,
  log,
  PTYD_ENTRY,
  readRunInfo,
  type HostAddress,
  type HostPaths,
  type RunInfo,
} from '@vesper/ptyd/client';

export interface SupervisorOptions {
  home: string;
  /** Node arguments that start ptyd; by default its built entry. Tests run the sources through tsx. */
  ptydArgs?: string[];
  readyTimeoutMs?: number;
  heartbeatMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps vesper-web connected to vesper-ptyd: starts the host when it is not
 * running, reconnects when the connection drops, and sends heartbeats. A host
 * that stops answering is only reported, never killed: that would end every session.
 */
export class HostSupervisor {
  private readonly paths: HostPaths;
  private client: ControlClient | undefined;
  private address: HostAddress | undefined;
  private connecting: Promise<ControlClient> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private stopped = false;
  private missed = 0;
  private backoffMs = MIN_BACKOFF_MS;
  private nextSpawnAt = 0;
  private readonly clientListeners = new Set<(client: ControlClient) => void>();

  constructor(private readonly options: SupervisorOptions) {
    this.paths = hostPaths(options.home);
  }

  /** Called with each new connection to the host, so its events can be followed. */
  onClient(listener: (client: ControlClient) => void): () => void {
    this.clientListeners.add(listener);
    return () => this.clientListeners.delete(listener);
  }

  /** Connects (starting the host if needed) and begins heartbeats. */
  start(): Promise<ControlClient> {
    this.heartbeat ??= setInterval(() => void this.beat(), this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    return this.control();
  }

  /** The control connection, reconnecting or starting the host if needed. */
  control(): Promise<ControlClient> {
    if (this.client && !this.client.isClosed) return Promise.resolve(this.client);
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Where attach connections go, as of the current host. */
  async attachAddress(): Promise<HostAddress> {
    await this.control();
    if (!this.address) throw new HostClosedError();
    return this.address;
  }

  /** Disconnects; the host and its sessions keep running. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.client?.close();
  }

  private async connect(): Promise<ControlClient> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    for (;;) {
      if (this.stopped) throw new HostClosedError();
      const run = readRunInfo(this.paths.runFile);
      if (run) {
        try {
          return this.adopt(await ControlClient.connect({ pipe: run.pipe, token: run.token }), run);
        } catch (error) {
          if ((error as { code?: string }).code === 'version_mismatch') throw error;
          // a stale run file or a host still starting: look again below
        }
      }
      if (Date.now() >= this.nextSpawnAt && !(await pipeAnswers(this.paths.pipe))) this.launch();
      if (Date.now() > deadline) throw new Error('the terminal host did not become ready');
      await sleep(POLL_MS);
    }
  }

  private launch(): void {
    const args = this.options.ptydArgs ?? [PTYD_ENTRY];
    log.info(`starting the terminal host: ${process.execPath} ${args.join(' ')}`);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, VESPER_HOME: this.options.home },
    });
    child.on('error', (error) => log.error('could not start the terminal host', error));
    child.on('exit', (code) => {
      if (code !== 0) log.warn(`the terminal host exited with code ${code}; see ${this.paths.logFile}`);
    });
    child.unref();
    // A host that crashes on start is retried later, not in a tight loop.
    this.nextSpawnAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private adopt(client: ControlClient, run: RunInfo): ControlClient {
    this.client = client;
    this.address = { pipe: run.pipe, token: run.token };
    this.backoffMs = MIN_BACKOFF_MS;
    this.nextSpawnAt = 0;
    this.missed = 0;
    client.onClose(() => this.handleClose(client));
    log.info(`connected to the terminal host (pid ${run.pid})`);
    for (const listener of this.clientListeners) {
      try {
        listener(client);
      } catch (error) {
        log.error('a host connection listener failed', error);
      }
    }
    return client;
  }

  private handleClose(client: ControlClient): void {
    if (this.client === client) this.client = undefined;
    if (this.stopped) return;
    log.warn('lost the connection to the terminal host; reconnecting');
    void this.control().catch((error) => log.error('could not reconnect to the terminal host', error));
  }

  private async beat(): Promise<void> {
    const client = this.client;
    if (!client || client.isClosed) {
      // Reconnect on our own, so the next page load finds the host ready.
      await this.control().catch((error: Error) => log.warn(`terminal host still unavailable: ${error.message}`));
      return;
    }
    const timeoutMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      if (this.missed > 0) log.info('the terminal host answers again');
      this.missed = 0;
    } catch {
      this.missed++;
      log.warn(`the terminal host missed ${this.missed} heartbeat(s); leaving it running`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whether anything listens on the pipe, such as a host that is still restoring its sessions. */
function pipeAnswers(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipe);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
