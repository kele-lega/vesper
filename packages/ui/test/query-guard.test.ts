import xtermHeadless from '@xterm/headless';
import { describe, expect, test } from 'vitest';
import { guardTerminalQueries } from '../src/query-guard.js';

/** Writes data to a terminal and resolves with every reply the terminal generated. */
async function repliesTo(data: string, guarded: boolean): Promise<string[]> {
  const term = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  if (guarded) guardTerminalQueries(term.parser);
  const replies: string[] = [];
  term.onData((reply) => replies.push(reply));
  await new Promise<void>((resolve) => term.write(data, resolve));
  term.dispose();
  return replies;
}

const QUERIES: [string, string][] = [
  ['DA1', '\x1b[c'],
  ['DA1 with 0', '\x1b[0c'],
  ['DA2', '\x1b[>c'],
  ['DSR status', '\x1b[5n'],
  ['DSR cursor position', '\x1b[6n'],
  ['DEC DSR cursor position', '\x1b[?6n'],
  ['DECRQM ANSI mode', '\x1b[4$p'],
  ['DECRQM DEC mode', '\x1b[?2026$p'],
  ['DECRQSS', '\x1bP$qm\x1b\\'],
  ['OSC 10 foreground', '\x1b]10;?\x07'],
  ['OSC 11 background', '\x1b]11;?\x1b\\'],
  ['OSC 12 cursor', '\x1b]12;?\x07'],
  ['OSC 4 palette', '\x1b]4;1;?\x07'],
];

describe('guardTerminalQueries', () => {
  // The headless core answers these; only the browser build answers the OSC colour queries.
  const CORE_ANSWERED = QUERIES.filter(([name]) => !name.startsWith('OSC'));
  test.each(CORE_ANSWERED)('an unguarded terminal answers %s (sanity check)', async (_name, query) => {
    expect(await repliesTo(query, false)).not.toEqual([]);
  });

  test.each(QUERIES)('a guarded terminal does not answer %s', async (_name, query) => {
    expect(await repliesTo(query, true)).toEqual([]);
  });

  test('still applies sequences that are not queries', async () => {
    const term = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    guardTerminalQueries(term.parser);
    await new Promise<void>((resolve) => term.write('ab\x1b[1;1Hc\x1b]0;title\x07', resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('cb');
    term.dispose();
  });

  test('dispose removes the guard', async () => {
    const term = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const dispose = guardTerminalQueries(term.parser);
    dispose();
    const replies: string[] = [];
    term.onData((reply) => replies.push(reply));
    await new Promise<void>((resolve) => term.write('\x1b[c', resolve));
    expect(replies).not.toEqual([]);
    term.dispose();
  });
});
