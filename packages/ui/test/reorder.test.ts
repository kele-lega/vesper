import { describe, expect, test } from 'vitest';
import { moveItem } from '../src/app/reorder.js';

describe('moveItem', () => {
  test('drops after the target when moving right, before it when moving left', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
    expect(moveItem(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });

  test('leaves the order alone for an unknown or identical item', () => {
    const ids = ['a', 'b'];
    expect(moveItem(ids, 'a', 'a')).toBe(ids);
    expect(moveItem(ids, 'x', 'a')).toBe(ids);
    expect(moveItem(ids, 'a', 'x')).toBe(ids);
  });
});
