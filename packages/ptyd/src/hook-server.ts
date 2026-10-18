/**
 * Receives agent hooks (design.md §7.1): one HTTP listener on 127.0.0.1 with a random port,
 * and a random token per session in the path. Every request is answered at once with `{}`,
 * so a slow or failing receiver never holds an agent up, and a hook never decides anything.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from './log.js';

const MAX_BODY = 1 << 20;
const TOKEN_BYTES = 24;
const PATH = /^\/hook\/([A-Za-z0-9_-]{32})$/;

export type HookHandler = (payload: unknown) => void;

export interface HookRegistration {
  /** The URL this session's hooks post to. */
  url: string;
  dispose(): void;
}

export class HookServer {
  private readonly handlers = new Map<string, HookHandler>();
  private server: Server | undefined;
  private port = 0;

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const token = PATH.exec(req.url ?? '')?.[1];
      const handler = token === undefined ? undefined : this.handlers.get(token);
      if (req.method !== 'POST' || !handler) {
        res.writeHead(404).end();
        req.resume();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        if (size > MAX_BODY) return;
        try {
          handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          log.warn('ignoring a hook that is not JSON');
        }
      });
    });
    server.on('clientError', (_, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  register(handler: HookHandler): HookRegistration {
    if (!this.server) throw new Error('the hook server is not started');
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.handlers.set(token, handler);
    return { url: `http://127.0.0.1:${this.port}/hook/${token}`, dispose: () => this.handlers.delete(token) };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
