import xtermHeadless from '@xterm/headless';
import { describe, expect, test } from 'vitest';
import { answerColourQueries } from '../src/colour-queries.js';

async function repliesTo(data: string): Promise<string[]> {
  const term = new xtermHeadless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies: string[] = [];
  answerColourQueries(term.parser, (reply) => replies.push(reply));
  await new Promise<void>((resolve) => term.write(data, resolve));
  term.dispose();
  return replies;
}

describe('answerColourQueries', () => {
  test.each([
    ['OSC 10 foreground', '\x1b]10;?\x07', '\x1b]10;rgb:cccc/cccc/cccc\x07'],
    ['OSC 11 background', '\x1b]11;?\x1b\\', '\x1b]11;rgb:0c0c/0c0c/0c0c\x07'],
    ['OSC 12 cursor', '\x1b]12;?\x07', '\x1b]12;rgb:ffff/ffff/ffff\x07'],
  ])('answers %s from the Campbell theme', async (_name, query, reply) => {
    expect(await repliesTo(query)).toEqual([reply]);
  });

  test('answers chained dynamic colour queries one by one', async () => {
    expect(await repliesTo('\x1b]10;?;?\x07')).toEqual(['\x1b]10;rgb:cccc/cccc/cccc\x07', '\x1b]11;rgb:0c0c/0c0c/0c0c\x07']);
  });

  test('answers OSC 4 palette queries, including the 256-colour cube', async () => {
    expect(await repliesTo('\x1b]4;1;?;196;?\x07')).toEqual(['\x1b]4;1;rgb:c5c5/0f0f/1f1f\x07', '\x1b]4;196;rgb:ffff/0000/0000\x07']);
  });

  test.each([
    ['setting a colour', '\x1b]11;#202020\x07'],
    ['an out-of-range palette index', '\x1b]4;256;?\x07'],
    ['a malformed palette query', '\x1b]4;x;?\x07'],
  ])('ignores %s', async (_name, sequence) => {
    expect(await repliesTo(sequence)).toEqual([]);
  });
});
