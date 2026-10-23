import { describe, expect, test } from 'vitest';
import { splitInput, terminalKeyInput } from '../src/input.js';

describe('splitInput', () => {
  test('keeps short input in one piece', () => {
    expect(splitInput('ls\r', 8)).toEqual(['ls\r']);
  });

  test('splits long input into pieces of at most maxChars', () => {
    expect(splitInput('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('never splits a surrogate pair', () => {
    const pieces = splitInput('ab😀cd', 3);
    expect(pieces.join('')).toBe('ab😀cd');
    for (const piece of pieces) expect(new TextDecoder().decode(new TextEncoder().encode(piece))).not.toContain('�');
  });

  test('returns nothing for empty input', () => {
    expect(splitInput('', 4)).toEqual([]);
  });
});

describe('terminalKeyInput', () => {
  test('encodes the terminal control keys without printable modifier text', () => {
    expect(terminalKeyInput('Escape', false)).toBe('\x1b');
    expect(terminalKeyInput('Tab', false)).toBe('\t');
    expect(terminalKeyInput('Ctrl+C', false)).toBe('\x03');
    expect(terminalKeyInput('Ctrl+D', false)).toBe('\x04');
    expect(terminalKeyInput('Ctrl+Z', false)).toBe('\x1a');
    expect(terminalKeyInput('Ctrl+L', false)).toBe('\x0c');
  });

  test.each([
    ['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D'],
  ] as const)('encodes %s in normal and application cursor modes', (key, suffix) => {
    expect(terminalKeyInput(key, false)).toBe(`\x1b[${suffix}`);
    expect(terminalKeyInput(key, true)).toBe(`\x1bO${suffix}`);
  });

  test('application cursor mode does not change non-arrow keys', () => {
    expect(terminalKeyInput('Escape', true)).toBe('\x1b');
    expect(terminalKeyInput('Tab', true)).toBe('\t');
    expect(terminalKeyInput('Ctrl+C', true)).toBe('\x03');
  });
});
