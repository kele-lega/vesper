import type { IncomingMessage } from 'node:http';
import { WS_TICKET_PREFIX } from '@vesper/protocol';

/** The WebSocket subprotocol the server answers with; a one-time ticket travels as a second, prefixed entry. */
export const WS_PROTOCOL = 'vesper.v1';

/** Browsers cannot set headers on WebSockets, so the ticket rides in Sec-WebSocket-Protocol, not the URL. */
export function protocolTicket(req: IncomingMessage): string | undefined {
  const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((entry) => entry.trim());
  return offered.find((entry) => entry.startsWith(WS_TICKET_PREFIX))?.slice(WS_TICKET_PREFIX.length);
}
