import { ScreenMirror } from './mirror.js';
import type { SessionFiles } from './persistence.js';
import type { TerminalSize } from './session.js';

/** Most logged output replayed on restore; checkpoints keep the real tail far smaller. */
export const MAX_RESTORE_TAIL = 16 << 20;

export interface RestoredScreen {
  mirror: ScreenMirror;
  /** Incarnation the screen belongs to, and its output offset after the replay. */
  inc: number;
  seq: number;
  /** False when nothing was saved: a session that never printed anything. */
  hasHistory: boolean;
}

/** Rebuilds a session's screen from its checkpoint and the output logged after it. */
export async function loadScreen(files: SessionFiles, fallback: TerminalSize & { inc: number }, scrollback: number): Promise<RestoredScreen> {
  const checkpoint = files.readCheckpoint();
  const loggedInc = files.latestLoggedInc();
  // The newest incarnation with saved data; a checkpoint from an older one is history the log replaces.
  const inc = checkpoint || loggedInc !== undefined ? Math.max(checkpoint?.inc ?? 0, loggedInc ?? 0) : fallback.inc;
  const base = checkpoint?.inc === inc ? checkpoint : undefined;
  const tail = files.readTail(inc, base?.seq, MAX_RESTORE_TAIL);
  const size = base ?? tail.parts[0] ?? fallback;
  const mirror = new ScreenMirror({ cols: size.cols, rows: size.rows, scrollback });
  if (base) mirror.write(base.data);
  for (const part of tail.parts) {
    // Each part was written at its own size; resize where the pty did (the resize prelude is already in the bytes).
    if (part.cols !== mirror.cols || part.rows !== mirror.rows) {
      await mirror.flush();
      mirror.resize(part.cols, part.rows);
    }
    mirror.write(part.data);
  }
  await mirror.flush();
  return {
    mirror,
    inc,
    seq: tail.from + tail.bytes,
    hasHistory: (base !== undefined && base.data !== '') || tail.bytes > 0,
  };
}

/**
 * Closes off restored history before a new shell starts on the same screen:
 * leaves any full-screen program's state, writes a dim separator under the last
 * line, and scrolls it all into scrollback. ConPTY then draws the new shell on
 * a blank screen, as it expects to.
 */
export async function appendRestoreMarker(mirror: ScreenMirror, savedAt: Date): Promise<void> {
  // Alternate screen, mouse tracking, focus events and bracketed paste off; then a soft reset.
  mirror.write('\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[!p');
  await mirror.flush();
  const row = Math.min(mirror.lastUsedRow() + 2, mirror.rows); // 1-based, just below the last text
  const label = ` 已恢复历史 · ${formatLocal(savedAt)} `;
  mirror.write(`\x1b[${row};1H\x1b[2;90m${'─'.repeat(4)}${label}${'─'.repeat(4)}\x1b[0m`);
  mirror.write(`${'\r\n'.repeat(mirror.rows)}\x1b[H`);
  await mirror.flush();
}

function formatLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
