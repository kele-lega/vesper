import { decodeFrame, encodeFrame, HostApiError, type Frame, type ResumePoint, type TerminalSize } from '@vesper/protocol';
import { AttachChannel, log, type HostAddress } from '@vesper/ptyd/client';
import type { RawData, WebSocket } from 'ws';

/** WebSocket close codes the page acts on. */
export const CLOSE = {
  /** The session was deleted: do not reconnect. */
  removed: 4000,
  /** No such session: do not reconnect. */
  notFound: 4004,
  /** The host is restarting: reconnect. */
  restarting: 1012,
  /** The host could not be reached or dropped the stream: reconnect. */
  unavailable: 1011,
  policy: 1008,
} as const;

export interface RelayTarget {
  session: string;
  resume?: ResumePoint;
  size?: TerminalSize;
}

/** Input kept while the host has not answered yet, and most bytes either side may leave unread. */
export const RELAY_LIMITS = { earlyBytes: 1 << 20, buffered: 16 << 20 };

/**
 * Connects one browser WebSocket to one attach channel on the host. Frames
 * pass through unchanged, after a check; pings are answered here. The host's ack
 * window bounds output, but a client that acks without reading, or floods input,
 * is cut off once its side holds more than RELAY_LIMITS.buffered unsent bytes.
 */
export function relay(ws: WebSocket, address: Promise<HostAddress>, target: RelayTarget): void {
  let channel: AttachChannel | undefined;
  let closed = false;
  const early: Uint8Array[] = [];
  let earlyBytes = 0;

  ws.on('message', (raw, isBinary) => {
    const bytes = isBinary ? toBytes(raw) : undefined;
    const frame = bytes ? safeDecode(bytes) : undefined;
    if (!bytes || !frame) return ws.close(CLOSE.policy, 'bad frame');
    if (frame.type === 'ping') return sendFrame(ws, { type: 'pong', nonce: frame.nonce });
    if (frame.type !== 'input' && frame.type !== 'resize' && frame.type !== 'ack') return ws.close(CLOSE.policy, 'unexpected frame');
    if (channel) {
      channel.sendRaw(bytes);
      if (channel.buffered > RELAY_LIMITS.buffered) ws.close(CLOSE.policy, 'input not read');
      return;
    }
    early.push(bytes); // typed before the host answered: keep the order
    earlyBytes += bytes.length;
    if (earlyBytes > RELAY_LIMITS.earlyBytes) ws.close(CLOSE.policy, 'too much input before attach');
  });
  ws.on('error', (error) => log.warn(`browser connection to ${target.session}: ${error.message}`));
  ws.on('close', () => {
    closed = true;
    channel?.close();
  });

  void address
    .then((where) => AttachChannel.open(where, target))
    .then(
      (opened) => {
        if (closed) return opened.close();
        channel = opened;
        forward(ws, opened);
        for (const bytes of early.splice(0)) opened.sendRaw(bytes);
      },
      (error: unknown) => {
        const missing = error instanceof HostApiError && error.code === 'not_found';
        if (!missing) log.warn(`could not attach to ${target.session}`, (error as Error).message);
        ws.close(missing ? CLOSE.notFound : CLOSE.unavailable, missing ? 'no such session' : 'terminal host unavailable');
      },
    );
}

function forward(ws: WebSocket, channel: AttachChannel): void {
  let code: number = CLOSE.unavailable;
  channel.onFrame((frame, raw) => {
    if (frame.type === 'closed') {
      code = frame.reason === 'removed' ? CLOSE.removed : CLOSE.restarting;
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    ws.send(raw);
    if (ws.bufferedAmount > RELAY_LIMITS.buffered) ws.close(CLOSE.policy, 'output not read');
  });
  channel.onClose(() => {
    if (ws.readyState === ws.OPEN) ws.close(code, code === CLOSE.removed ? 'session removed' : 'stream ended');
  });
}

function toBytes(raw: RawData): Uint8Array | undefined {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : undefined;
}

function safeDecode(bytes: Uint8Array): Frame | undefined {
  try {
    return decodeFrame(bytes);
  } catch {
    return undefined;
  }
}

function sendFrame(ws: WebSocket, frame: Frame): void {
  if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame));
}
