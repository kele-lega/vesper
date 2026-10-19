import { connect, type Socket } from 'node:net';
import {
  decodeFrame,
  decodeJson,
  encodeJson,
  encodePipeMessage,
  HOST_PROTOCOL_VERSION,
  HostApiError,
  isRecord,
  parseChallenge,
  parseControlMessage,
  parseHelloReply,
  PipeReader,
  type ControlResults,
  type CreateOptions,
  type Elevation,
  type Frame,
  type HelloReply,
  type HostEvent,
  type ResumePoint,
  type SessionInfo,
  type TerminalSize,
} from '@vesper/protocol';
import { checkProof, newNonce, proof } from './handshake.js';
import { Listeners } from './log.js';

export * from './paths.js';
export { log, setLogSink } from './log.js';
export { compileLauncher, hostIsElevated, launcherFor, protectHome } from './launcher.js';
export { LAUNCH_CWD_ENV } from './shells.js';

/** Where a running ptyd listens, and the token from its run file. */
export interface HostAddress {
  pipe: string;
  token: string;
}

const HELLO_TIMEOUT_MS = 5000;

export class HostClosedError extends Error {
  override name = 'HostClosedError';
  constructor() {
    super('connection to the terminal host closed');
  }
}

/**
 * Connects and runs the handshake (see host-api.ts): the host must prove it holds
 * the token before this side proves it does. Resolves once the host accepts;
 * later messages go to onMessage.
 */
function open(address: HostAddress, hello: object, onMessage: (payload: Uint8Array) => void): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(address.pipe);
    const nonce = newNonce();
    let stage: 'challenge' | 'reply' | 'accepted' = 'challenge';
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('terminal host did not answer')), HELLO_TIMEOUT_MS);
    const reader = new PipeReader((payload) => {
      if (stage === 'accepted') return onMessage(payload);
      const message = decodeJson(payload);
      if (isRecord(message) && message.ok === false) {
        const refusal = parseHelloReply(message) as Extract<HelloReply, { ok: false }>;
        return fail(new HostApiError(refusal.error, refusal.message));
      }
      if (stage === 'challenge') {
        const { proof: hostProof, nonce: hostNonce } = parseChallenge(message);
        // Whatever answers on the pipe must hold the token; an impostor learns nothing from us.
        if (!checkProof(address.token, 'host', nonce, hostProof)) {
          return fail(new HostApiError('unauthorized', 'the terminal host could not prove it holds the token'));
        }
        stage = 'reply';
        socket.write(encodePipeMessage(encodeJson({ proof: proof(address.token, 'client', hostNonce) })));
        return;
      }
      parseHelloReply(message);
      stage = 'accepted';
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('data', (chunk) => {
      try {
        reader.push(chunk);
      } catch (error) {
        if (stage === 'accepted') socket.destroy();
        else fail(error as Error);
      }
    });
    socket.on('error', (error) => {
      if (stage !== 'accepted') fail(error);
    });
    socket.on('close', () => {
      if (stage !== 'accepted') fail(new HostClosedError());
    });
    socket.once('connect', () => {
      socket.write(encodePipeMessage(encodeJson({ ...hello, v: HOST_PROTOCOL_VERSION, nonce })));
    });
  });
}

/** Requests, responses and session events on a control connection. */
export class ControlClient {
  static async connect(address: HostAddress): Promise<ControlClient> {
    const client = new ControlClient();
    client.socket = await open(address, { role: 'control' }, (payload) => client.handle(payload));
    client.socket.on('close', () => client.handleClose());
    return client;
  }

  private socket!: Socket;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly events = new Listeners<HostEvent>('host event');
  private readonly closes = new Listeners<void>('host close');

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    return this.events.add(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.closed) queueMicrotask(listener);
    return this.closes.add(listener);
  }

  ping(): Promise<ControlResults['ping']> {
    return this.request('ping');
  }

  async list(): Promise<SessionInfo[]> {
    return (await this.request('list')).sessions;
  }

  /** elevation is required: a forgotten one must not mean the host's admin token. */
  async create(options: CreateOptions & { elevation: Elevation }): Promise<SessionInfo> {
    return (await this.request('create', options)).session;
  }

  /** Starts an exited session's shell or command again; attached clients are closed with 'restarted'. */
  async restart(session: string): Promise<SessionInfo> {
    return (await this.request('restart', { session })).session;
  }

  async kill(session: string): Promise<void> {
    await this.request('kill', { session });
  }

  async remove(session: string): Promise<void> {
    await this.request('remove', { session });
  }

  async shutdown(): Promise<void> {
    await this.request('shutdown');
  }

  close(): void {
    this.socket.destroy();
  }

  private request<K extends keyof ControlResults>(op: K, fields: object = {}): Promise<ControlResults[K]> {
    if (this.closed) return Promise.reject(new HostClosedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.write(encodePipeMessage(encodeJson({ ...fields, id, op })));
    });
  }

  private handle(payload: Uint8Array): void {
    const message = parseControlMessage(decodeJson(payload));
    if ('event' in message) return this.events.emit(message);
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new HostApiError(message.error, message.message));
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new HostClosedError());
    this.pending.clear();
    this.closes.emit();
  }
}

export interface AttachOptions {
  session: string;
  resume?: ResumePoint;
  size?: TerminalSize;
}

/** One session's frame stream. Frames arriving before onFrame is set are kept for it. */
export class AttachChannel {
  static async open(address: HostAddress, options: AttachOptions): Promise<AttachChannel> {
    const channel = new AttachChannel();
    channel.socket = await open(address, { role: 'attach', ...options }, (payload) => channel.handle(payload));
    channel.socket.on('close', () => channel.handleClose());
    return channel;
  }

  private socket!: Socket;
  private closed = false;
  private queue: [Frame, Uint8Array][] | undefined = [];
  private listener: ((frame: Frame, raw: Uint8Array) => void) | undefined;
  private readonly closes = new Listeners<void>('attach close');

  /** Receives each frame both decoded and as its original bytes, ready to forward. */
  onFrame(listener: (frame: Frame, raw: Uint8Array) => void): void {
    this.listener = listener;
    const queued = this.queue ?? [];
    this.queue = undefined;
    for (const [frame, raw] of queued) listener(frame, raw);
  }

  onClose(listener: () => void): () => void {
    if (this.closed) queueMicrotask(listener);
    return this.closes.add(listener);
  }

  /** Sends one frame given in its encoded form (see frames.ts). */
  sendRaw(raw: Uint8Array): void {
    if (!this.closed && this.socket.writable) this.socket.write(encodePipeMessage(raw));
  }

  /** Bytes written but not yet taken by the host. */
  get buffered(): number {
    return this.socket.writableLength;
  }

  close(): void {
    this.socket.end();
  }

  private handle(payload: Uint8Array): void {
    const frame = decodeFrame(payload);
    if (this.queue) this.queue.push([frame, payload]);
    else this.listener?.(frame, payload);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closes.emit();
  }
}
