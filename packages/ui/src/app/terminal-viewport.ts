import { useLayoutEffect, useRef, type RefObject } from 'react';

const COMPACT_HEIGHT_PX = 360;

/** Keep the terminal above the on-screen keyboard without refitting it while the user pinch-zooms. */
export function useTerminalViewport(): RefObject<HTMLDivElement | null> {
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = page.current;
    if (!element) return;
    const touch = window.matchMedia('(pointer: coarse)');
    const viewport = window.visualViewport;
    let frame = 0;
    const reset = () => {
      element.style.removeProperty('--terminal-viewport-height');
      element.style.removeProperty('--terminal-viewport-top');
      element.removeAttribute('data-terminal-compact');
    };
    const update = () => {
      if (!touch.matches) return reset();
      // A zoomed visual viewport is smaller too; keep the layout still so zooming and panning stay native.
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height ?? window.innerHeight;
      element.style.setProperty('--terminal-viewport-height', `${height}px`);
      element.style.setProperty('--terminal-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      element.toggleAttribute('data-terminal-compact', height < COMPACT_HEIGHT_PX);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    touch.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      touch.removeEventListener('change', schedule);
      reset();
    };
  }, []);
  return page;
}
