import { useEffect, useState } from 'react';

/** Keys the browser keeps for itself (close tab, new tab, new window, switch tab) unless the keyboard is locked. */
const LOCKED_KEYS = ['KeyW', 'KeyT', 'KeyN', 'Tab', 'Escape'];

interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}

/**
 * Fullscreen with the Keyboard Lock API: there Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab reach the terminal
 * and the page instead of the browser. Holding Esc leaves fullscreen.
 */
export function FullscreenButton() {
  const [full, setFull] = useState(() => document.fullscreenElement !== null);

  useEffect(() => {
    const changed = () => {
      const now = document.fullscreenElement !== null;
      setFull(now);
      const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
      if (now) void keyboard?.lock(LOCKED_KEYS).catch(() => undefined);
      else keyboard?.unlock();
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const toggle = () => void (full ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined);
  return (
    <button type="button" className="icon-button fullscreen-button" onClick={toggle} aria-label={full ? '退出全屏' : '全屏（可用 Ctrl+W/T/N）'} title={full ? '退出全屏（长按 Esc）' : '全屏：Ctrl+W/T/N 交给终端'}>
      {full ? '🗗' : '⛶'}
    </button>
  );
}
