import { useEffect, useRef } from 'react';
import { TerminalSession, type SessionView } from '../terminal-session.js';

interface Props {
  /** The tab in front, if any. */
  active: string | undefined;
  /** Every tab still open; terminals of closed tabs are disposed. */
  sessionIds: readonly string[];
  onView: (sessionId: string, view: SessionView) => void;
}

/**
 * The terminals behind the tab bar. A terminal is made the first time its tab
 * comes to the front and kept while the tab stays open, so switching back is
 * instant; tabs behind hold no socket and no WebGL context.
 */
export function TerminalArea({ active, sessionIds, onView }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const sessions = useRef(new Map<string, { session: TerminalSession; element: HTMLDivElement }>());
  const report = useRef(onView);
  report.current = onView;
  // A new array each render; the joined ids change only when the tabs do.
  const openIds = sessionIds.join('\n');

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const keep = new Set(openIds.split('\n'));
    const open = sessions.current;
    for (const [id, { session, element }] of open) {
      if (keep.has(id)) continue;
      session.dispose();
      element.remove();
      open.delete(id);
    }
    for (const [id, { session, element }] of open) {
      if (id === active) continue;
      if (!element.hidden) session.deactivate();
      element.hidden = true;
    }
    if (active === undefined) return;
    let entry = open.get(active);
    if (!entry) {
      const element = document.createElement('div');
      element.className = 'terminal';
      host.append(element);
      const id = active;
      entry = { element, session: new TerminalSession(id, element, (view) => report.current(id, view)) };
      open.set(active, entry);
    }
    entry.element.hidden = false;
    entry.session.activate();
  }, [active, openIds]);

  useEffect(
    () => () => {
      for (const { session, element } of sessions.current.values()) {
        session.dispose();
        element.remove();
      }
      sessions.current.clear();
    },
    [],
  );

  return <div ref={container} className="terminals" />;
}
