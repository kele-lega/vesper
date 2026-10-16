import { describe, expect, test } from 'vitest';
import { TICKET_MS, TicketBook } from '../src/ws-tickets.js';

describe('TicketBook', () => {
  test('a ticket opens one socket for its device, once, within a minute', () => {
    let now = 0;
    const book = new TicketBook(() => now);
    const ticket = book.issue('device-1');
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(book.redeem(ticket)).toBe('device-1');
    expect(book.redeem(ticket)).toBeUndefined();
    const late = book.issue('device-1');
    now += TICKET_MS;
    expect(book.redeem(late)).toBeUndefined();
    expect(book.redeem('made-up')).toBeUndefined();
  });

  test('revoking a device voids its tickets', () => {
    const book = new TicketBook();
    const mine = book.issue('a');
    const theirs = book.issue('b');
    book.revokeDevice('a');
    expect(book.redeem(mine)).toBeUndefined();
    expect(book.redeem(theirs)).toBe('b');
  });

  test('holds a bounded number of tickets, dropping the oldest', () => {
    const book = new TicketBook(Date.now, 3);
    const tickets = ['a', 'b', 'c', 'd'].map((device) => book.issue(device));
    expect(book.redeem(tickets[0]!)).toBeUndefined();
    expect(tickets.slice(1).map((ticket) => book.redeem(ticket))).toEqual(['b', 'c', 'd']);
  });
});
