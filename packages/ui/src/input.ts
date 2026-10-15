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
