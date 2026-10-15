import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, test } from 'vitest';
import { OrderedTerminal } from '../src/ordered-terminal.js';

const terminals: InstanceType<typeof xtermHeadless.Terminal>[] = [];
function create(cols = 20, rows = 4) {
  const term = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true });
  terminals.push(term);
  return { term, ordered: new OrderedTerminal(term) };
}
const row = (term: InstanceType<typeof xtermHeadless.Terminal>, y: number) =>
  term.buffer.active.getLine(y)?.translateToString(true) ?? '';
const settled = (term: InstanceType<typeof xtermHeadless.Terminal>) => new Promise<void>((resolve) => term.write('', resolve));

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

describe('OrderedTerminal', () => {
  test('a resize waits for the output queued before it', async () => {
    const { term, ordered } = create();
    const seen: number[] = [];
    ordered.write('before', () => seen.push(term.cols));
    ordered.resize(10, 4);
    ordered.write('after', () => seen.push(term.cols));
    await settled(term);
    expect(seen).toEqual([20, 10]);
  });

  test('a new screen replaces whatever was queued before it, and later output lands on it', async () => {
    const { term, ordered } = create();
    ordered.write('stale output that must not survive');
    ordered.replace(30, 3, 'fresh');
    ordered.write(' more');
    await settled(term);
    expect([term.cols, term.rows]).toEqual([30, 3]);
    expect(row(term, 0)).toBe('fresh more');
  });

  test('runs parsed callbacks in order', async () => {
    const { term, ordered } = create();
    const order: string[] = [];
    ordered.write('a', () => order.push('a'));
    ordered.replace(20, 4, 'b', () => order.push('b'));
    ordered.write('c', () => order.push('c'));
    ordered.resize(20, 4);
    ordered.write('d', () => order.push('d'));
    await settled(term);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });
});
