import { describe, expect, test } from 'vitest';
import { splitInput } from '../src/input.js';

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
