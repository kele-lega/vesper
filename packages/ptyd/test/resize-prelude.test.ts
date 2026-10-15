import { afterEach, describe, expect, test } from 'vitest';
import { ScreenMirror } from '../src/mirror.js';
import { conptyResizePrelude } from '../src/resize-prelude.js';

const at = (y: number, x = 37, rows = 37, cols = 118) => ({ cols, rows, cursor: { x, y }, alternateScreen: false });

describe('conptyResizePrelude', () => {
  // Measured against node-pty's bundled ConPTY: the cursor row after a row-only resize.
  test.each([
    [4, 35, 2],
    [4, 22, 0],
    [19, 22, 4],
    [31, 22, 16],
  ])('cursor on row %i, shrinking 37 -> %i rows, ends on row %i', async (y, rows, expected) => {
    const mirror = new ScreenMirror({ cols: 118, rows: 37, scrollback: 100 });
    mirrors.push(mirror);
    for (let row = 0; row < y; row++) mirror.write(`line ${row}\r\n`);
    mirror.write('C:\\Users\\ADMINI~1\\AppData\\Local\\Temp>'.slice(0, 37));
    await mirror.flush();
    mirror.write(conptyResizePrelude({ ...mirror.size, cursor: mirror.cursor, alternateScreen: false }, { cols: 118, rows }));
    await mirror.flush();
    mirror.resize(118, rows);
    expect(mirror.cursor).toEqual({ x: 37, y: expected });
    expect(mirror.screenText().split('\n')[expected]).toMatch(/Temp>$/);
  });

  test('adds nothing when growing, when the cursor is on the top row, or on the alternate screen', () => {
    expect(conptyResizePrelude(at(4, 37, 22), { cols: 118, rows: 37 })).toBe('');
    expect(conptyResizePrelude(at(0), { cols: 118, rows: 22 })).toBe('');
    expect(conptyResizePrelude({ ...at(10), alternateScreen: true }, { cols: 118, rows: 22 })).toBe('');
  });

  test('scrolls from the last row and puts the cursor back', () => {
    expect(conptyResizePrelude(at(19, 5), { cols: 118, rows: 22 })).toBe('\x1b[37;1H' + '\n'.repeat(15) + '\x1b[5;6H');
  });

  const mirrors: ScreenMirror[] = [];
  afterEach(() => {
    for (const mirror of mirrors.splice(0)) mirror.dispose();
  });
});
