import { randomBytes } from 'node:crypto';

/** How long a ticket stays valid: long enough to open a socket right after asking. */
export const TICKET_MS = 60_000;
const MAX_TICKETS = 10_000;

/**
 * One-time WebSocket tickets. A page trades its login cookie for a ticket over
 * a checked POST, then offers the ticket when opening the socket, so a socket
 * is never opened on the strength of an ambient cookie alone.
 */
export class TicketBook {
  /** Insertion order is issue order, which lets the oldest go first when full. */
  private readonly tickets = new Map<string, { device: string; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = MAX_TICKETS,
  ) {}

  issue(device: string): string {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt > now && this.tickets.size < this.capacity) break;
      this.tickets.delete(ticket);
    }
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { device, expiresAt: now + TICKET_MS });
    return ticket;
  }

  /** The device the ticket was issued to; a ticket works once. */
  redeem(ticket: string): string | undefined {
    const entry = this.tickets.get(ticket);
    if (!entry) return undefined;
    this.tickets.delete(ticket);
    return entry.expiresAt > this.now() ? entry.device : undefined;
  }

  revokeDevice(device: string): void {
    for (const [ticket, entry] of this.tickets) if (entry.device === device) this.tickets.delete(ticket);
  }
}
