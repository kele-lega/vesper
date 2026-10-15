/**
 * ConPTY (OpenConsole 1.23) sends nothing when the pty is resized: it rearranges
 * its own buffer and assumes the terminal did the same. xterm.js arranges rows
 * differently, so the next output lands on the wrong rows. The prelude is output
 * that moves the screen into ConPTY's arrangement just before the resize. ptyd
 * appends it to the session stream, so every viewer and the log get the same bytes.
 */

export interface ScreenState {
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  alternateScreen: boolean;
}

export interface TargetSize {
  cols: number;
  rows: number;
}

/**
 * Rows: shrinking by k drops min(k, cursor row) rows off the top (into
 * scrollback) and the rest off the bottom; growing adds blank rows at the bottom.
 * xterm.js drops rows below the cursor first, so the top part is scrolled away
 * here, which leaves blank rows below the cursor for xterm.js to drop.
 */
export function conptyResizePrelude(screen: ScreenState, to: TargetSize): string {
  if (screen.alternateScreen) return ''; // full-screen programs redraw after a resize
  const shrink = screen.rows - to.rows;
  const scroll = Math.min(Math.max(0, shrink), screen.cursor.y);
  if (scroll === 0) return '';
  const { x, y } = screen.cursor;
  // Line feeds on the last row push rows into scrollback; then put the cursor back on its (moved) row.
  return `\x1b[${screen.rows};1H${'\n'.repeat(scroll)}\x1b[${y - scroll + 1};${x + 1}H`;
}
