import { describe, expect, test } from 'vitest';
import { folderName } from '../src/web-routes.js';

describe('folderName', () => {
  test.each([
    ['vesper', 'vesper'],
    ['  博客 项目  ', '博客 项目'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j'],
    ['trailing dots...', 'trailing dots'],
  ])('%j → %j', (name, folder) => {
    expect(folderName(name, 'win32')).toBe(folder);
  });

  test.each(['', '   ', '...', 'CON', 'nul', 'com1', 'LPT9.txt', 'x'.repeat(200)])('refuses %j', (name) => {
    expect(folderName(name, 'win32')).toBeUndefined();
  });
});
