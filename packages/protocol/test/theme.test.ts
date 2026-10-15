import { describe, expect, test } from 'vitest';
import { CAMPBELL, palette256, xtermRgb } from '../src/theme.js';

describe('Campbell theme', () => {
  test('matches the Windows Terminal defaults', () => {
    expect(CAMPBELL.background).toBe('#0C0C0C');
    expect(CAMPBELL.foreground).toBe('#CCCCCC');
    expect(CAMPBELL.blue).toBe('#0037DA');
    expect(CAMPBELL.brightWhite).toBe('#F2F2F2');
  });

  test('formats colours as xterm 16-bit rgb replies', () => {
    expect(xtermRgb('#0C0C0C')).toBe('rgb:0c0c/0c0c/0c0c');
    expect(xtermRgb('#3B78FF')).toBe('rgb:3b3b/7878/ffff');
    expect(() => xtermRgb('red')).toThrow(/invalid colour/);
  });

  test('builds the 256-colour palette from Campbell, the 6x6x6 cube and the grey ramp', () => {
    const palette = palette256();
    expect(palette).toHaveLength(256);
    expect(palette[1]).toBe('#C50F1F');
    expect(palette[16]).toBe('#000000');
    expect(palette[21]).toBe('#0000FF');
    expect(palette[231]).toBe('#FFFFFF');
    expect(palette[232]).toBe('#080808');
    expect(palette[255]).toBe('#EEEEEE');
  });
});
