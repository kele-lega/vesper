import { createServer, type Server, type Socket } from 'node:net';
import {
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  encodePipeMessage,
  HOST_PROTOCOL_VERSION,
  HostApiError,
  MAX_PIPE_MESSAGE,
  parseControlRequest,
  parseHello,
  parseProof,
  PipeReader,
  type ControlRequest,
  type ControlResults,
  type Frame,
  type Hello,
  type HostErrorCode,
} from '@vesper/protocol';
import { checkProof, newNonce, proof } from './handshake.js';
import type { Host } from './host.js';
import { log } from './log.js';

export interface ServerOptions {
  pipe: string;
  token: string;
  host: Host;
  /** Called after answering a shutdown request. */
  onShutdown(): void;
  startedAt?: number;
}

export interface PipeServer {
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 200;
/** Nothing larger is accepted before the client has authenticated. */
const MAX_HELLO_BYTES = 64 * 1024;

type Handler = (payload: Uint8Array) => void;

/** Listens on the named pipe; rejects with EADDRINUSE when another host already does. */
export function startPipeServer(options: ServerOptions): Promise<PipeServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    accept(socket, options);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.pipe, () => {
      server.off('error', reject);
      server.on('error', (error) => log.error('pipe server error', error));
      resolve({ close: () => closeServer(server, sockets) });
    });
  });
}

/** Ends every connection, letting queued replies (such as the shutdown answer) flush first. */
function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.end();
    setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

const IGNORE: Handler = () => undefined;

/**
 * Runs the handshake (see host-api.ts): the hello gets a challenge that proves
 * this host holds the token, and only a client whose proof checks out gets a
 * channel and the full message size.
 */
function accept(socket: Socket, options: ServerOptions): void {
  let handler: Handler | undefined;
  let pending: { hello: Hello; nonce: string } | undefined;
  const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
  socket.on('error', (error) => log.warn('pipe client error', error.message));
  socket.on('close', () => clearTimeout(timer));
  const reader = new PipeReader((payload) => {
    if (handler) return handler(payload);
    if (!pending) {
      pending = challenge(socket, payload, options);
      if (!pending) handler = IGNORE; // refused
      return;
    }
    if (!clientProved(payload, options.token, pending.nonce)) {
      handler = IGNORE;
      return refuse(socket, 'unauthorized', 'bad proof');
    }
    clearTimeout(timer);
    reader.maxMessage = MAX_PIPE_MESSAGE; // the small limit guards everything before authentication
    const { hello } = pending;
    handler = hello.role === 'control' ? controlChannel(socket, options) : attachChannel(socket, hello, options);
  }, MAX_HELLO_BYTES);
  socket.on('data', (chunk) => {
    try {
      reader.push(chunk);
    } catch (error) {
      log.warn('dropping a pipe client', (error as Error).message);
      socket.destroy();
    }
  });
}

/** Answers a valid hello with this host's proof and a nonce for the client's; refuses anything else. */
function challenge(socket: Socket, payload: Uint8Array, options: ServerOptions): { hello: Hello; nonce: string } | undefined {
  let hello: Hello;
  try {
    hello = parseHello(decodeJson(payload));
  } catch (error) {
    const code: HostErrorCode = error instanceof HostApiError ? error.code : 'bad_request';
    refuse(socket, code, (error as Error).message);
    return undefined;
  }
  const nonce = newNonce();
  sendJson(socket, { proof: proof(options.token, 'host', hello.nonce), nonce });
  return { hello, nonce };
}

function clientProved(payload: Uint8Array, token: string, nonce: string): boolean {
  try {
    return checkProof(token, 'client', nonce, parseProof(decodeJson(payload)).proof);
  } catch {
    return false;
  }
}

/** Sends the refusal, then hangs up: a refused peer must not keep the connection. */
function refuse(socket: Socket, error: HostErrorCode, message: string): void {
  sendJson(socket, { ok: false, error, message });
  socket.end();
  setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
}

function controlChannel(socket: Socket, options: ServerOptions): Handler {
  const { host } = options;
  sendJson(socket, { ok: true, v: HOST_PROTOCOL_VERSION, pid: process.pid });
  const unsubscribe = host.onEvent((event) => sendJson(socket, event));
  socket.on('close', unsubscribe);
  return (payload) => {
    let request: ControlRequest;
    try {
      request = parseControlRequest(decodeJson(payload));
    } catch (error) {
      const requestId = error instanceof HostApiError ? error.requestId : undefined;
      if (requestId === undefined) throw error; // nothing to answer: drop the client
      sendJson(socket, { id: requestId, ok: false, error: 'bad_request', message: (error as Error).message });
      return;
    }
    void answer(socket, request, options);
  };
}

async function answer(socket: Socket, request: ControlRequest, options: ServerOptions): Promise<void> {
  try {
    const result = await run(request, options);
    sendJson(socket, { id: request.id, ok: true, result });
    if (request.op === 'shutdown') options.onShutdown();
  } catch (error) {
    const code: HostErrorCode = error instanceof HostApiError ? error.code : 'internal';
    if (code === 'internal') log.error(`control request ${request.op} failed`, error);
    sendJson(socket, { id: request.id, ok: false, error: code, message: (error as Error).message });
  }
}

function run(request: ControlRequest, options: ServerOptions): ControlResults[keyof ControlResults] {
  const { host } = options;
  switch (request.op) {
    case 'ping':
      return { pid: process.pid, uptimeMs: Date.now() - (options.startedAt ?? Date.now()) };
    case 'list':
      return { sessions: host.list() };
    case 'create':
      return { session: host.create(request) };
    case 'kill':
      host.kill(request.session);
      return {};
    case 'remove':
      host.remove(request.session);
      return {};
    case 'shutdown':
      return {};
  }
}

function attachChannel(socket: Socket, hello: Extract<Hello, { role: 'attach' }>, options: ServerOptions): Handler {
  const session = options.host.get(hello.session);
  if (!session) {
    refuse(socket, 'not_found', `no session ${hello.session}`);
    return IGNORE;
  }
  sendJson(socket, { ok: true, v: HOST_PROTOCOL_VERSION, pid: process.pid });
  const peer = {
    send: (frame: Frame) => {
      if (socket.writable) socket.write(encodeFrameMessage(frame));
    },
    close: () => socket.end(),
  };
  const attachment = session.attach(peer, {
    ...(hello.resume ? { resume: hello.resume } : {}),
    ...(hello.size ? { size: hello.size } : {}),
  });
  socket.on('close', () => session.detach(attachment));
  return (payload) => attachment.receive(decodeFrame(payload));
}

function encodeFrameMessage(frame: Frame): Uint8Array {
  return encodePipeMessage(encodeFrame(frame));
}

function sendJson(socket: Socket, value: unknown): void {
  if (socket.writable) socket.write(encodePipeMessage(encodeJson(value)));
}
