/**
 * Splits typed or pasted text into pieces of at most maxChars UTF-16 units, never inside a
 * surrogate pair, so a large paste fits the server's frame limit and every piece is valid UTF-8.
 */
export function splitInput(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    if (end === start) end = start + 2; // maxChars of 1 at a surrogate pair: keep the pair whole
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

const KEY_INPUT = {
  Escape: '\x1b',
  Tab: '\t',
  'Ctrl+C': '\x03',
  'Ctrl+D': '\x04',
  'Ctrl+Z': '\x1a',
  'Ctrl+L': '\x0c',
  ArrowLeft: '\x1b[D',
  ArrowDown: '\x1b[B',
  ArrowUp: '\x1b[A',
  ArrowRight: '\x1b[C',
} as const;

export type TerminalKey = keyof typeof KEY_INPUT;

/** DECCKM changes cursor keys from CSI to SS3, as used by full-screen terminal applications. */
export function terminalKeyInput(key: TerminalKey, applicationCursorKeys: boolean): string {
  const input = KEY_INPUT[key];
  return applicationCursorKeys && key.startsWith('Arrow') ? `\x1bO${input.slice(-1)}` : input;
}
