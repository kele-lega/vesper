/**
 * Answers OSC 10/11/12 (default colours) and OSC 4 (palette) queries from the Campbell theme.
 *
 * The headless mirror is the only party that answers terminal queries, and the headless
 * xterm core does not answer these itself (the browser build does, but browsers stay silent).
 */
import { CAMPBELL, palette256, xtermRgb } from '@vesper/protocol';

export interface OscParser {
  registerOscHandler(ident: number, handler: (data: string) => boolean): unknown;
}

/** Colours for OSC 10, 11 and 12, in that order. */
const DYNAMIC_COLOURS = [CAMPBELL.foreground, CAMPBELL.background, CAMPBELL.cursor];
const PALETTE = palette256();

export function answerColourQueries(parser: OscParser, reply: (data: string) => void): void {
  for (const ident of [10, 11, 12]) parser.registerOscHandler(ident, (data) => answerDynamic(ident, data, reply));
  parser.registerOscHandler(4, (data) => answerPalette(data, reply));
}

/** `OSC 10;?;?` asks for 10 and 11: each further `?` moves to the next colour. */
function answerDynamic(ident: number, data: string, reply: (data: string) => void): boolean {
  const parts = data.split(';');
  if (!parts.every((part) => part === '?')) return false;
  parts.forEach((_, offset) => {
    const colour = DYNAMIC_COLOURS[ident - 10 + offset];
    if (colour) reply(`\x1b]${ident + offset};${xtermRgb(colour)}\x07`);
  });
  return true;
}

function answerPalette(data: string, reply: (data: string) => void): boolean {
  const parts = data.split(';');
  if (parts.length < 2 || parts.length % 2 !== 0) return false;
  const indices: number[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const index = /^\d+$/.test(parts[i] ?? '') ? Number(parts[i]) : NaN;
    if (!(index <= 255) || parts[i + 1] !== '?') return false;
    indices.push(index);
  }
  for (const index of indices) reply(`\x1b]4;${index};${xtermRgb(PALETTE[index] ?? CAMPBELL.foreground)}\x07`);
  return true;
}
