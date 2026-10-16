import { afterEach, describe, expect, test } from 'vitest';
import { ScreenMirror } from '../src/mirror.js';
import { conptyResizePrelude, firstCursorPosition, shiftRows } from '../src/resize-prelude.js';

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

describe('shiftRows', () => {
  const screen = (y: number, x = 5) => ({ cols: 80, rows: 10, cursor: { x, y }, alternateScreen: false });
  const mirrors: ScreenMirror[] = [];
  afterEach(() => {
    for (const mirror of mirrors.splice(0)) mirror.dispose();
  });

  test('moves rows up into scrollback, or inserts blank rows at the top, keeping the cursor on its row', () => {
    expect(shiftRows(screen(6), 3)).toBe(`\x1b[10;1H${'\n'.repeat(3)}\x1b[4;6H`);
    expect(shiftRows(screen(2), -2)).toBe('\x1b[1;1H\x1b[2L\x1b[5;6H');
  });

  test('does nothing for no shift or on the alternate screen, and keeps the cursor on the screen', () => {
    expect(shiftRows(screen(6), 0)).toBe('');
    expect(shiftRows({ ...screen(6), alternateScreen: true }, 3)).toBe('');
    expect(shiftRows(screen(1), 5)).toBe(`\x1b[10;1H${'\n'.repeat(5)}\x1b[1;6H`);
    expect(shiftRows(screen(8), -50)).toBe('\x1b[1;1H\x1b[10L\x1b[10;6H');
  });

  test.each([2, -2])('a shift of %i keeps each row with its text', async (rows) => {
    const mirror = new ScreenMirror({ cols: 20, rows: 6, scrollback: 50 });
    mirrors.push(mirror);
    mirror.write('a\r\nb\r\nc\r\n> ');
    await mirror.flush();
    mirror.write(shiftRows({ ...mirror.size, cursor: mirror.cursor, alternateScreen: false }, rows));
    mirror.write('typed');
    await mirror.flush();
    expect(mirror.cursor.y).toBe(3 - rows);
    expect(mirror.screenText().split('\n')[3 - rows]).toBe('> typed');
  });
});

describe('firstCursorPosition', () => {
  test('finds the first absolute cursor position, 0-based, and where it is', () => {
    expect(firstCursorPosition('abc\x1b[2;38Hx\x1b[9;9H')).toEqual({ index: 3, length: 7, row: 1, col: 37 });
  });

  test.each(['plain text', '\x1b[5A', '\x1b[H', '\x1b[2;3f'])('finds none in %j', (text) => {
    expect(firstCursorPosition(text)).toBeUndefined();
  });
});
