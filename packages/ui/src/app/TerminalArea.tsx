import { useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { TerminalKey } from '../input.js';
import { TerminalSession, type SessionView } from '../terminal-session.js';
import { ServerPlatform } from './platform.js';
import { TerminalKeys } from './TerminalKeys.js';

interface Props {
  /** The tab in front, if any. */
  active: string | undefined;
  /** Every tab still open; terminals of closed tabs are disposed. */
  sessionIds: readonly string[];
  /** Tabs running an agent CLI. */
  agents: ReadonlySet<string>;
  onView: (sessionId: string, view: SessionView) => void;
  /** Ctrl+Shift+F opens the search box over the tab in front. */
  searching: boolean;
  onSearchEnd: () => void;
}

/**
 * The terminals behind the tab bar. A terminal is made the first time its tab
 * comes to the front and kept while the tab stays open, so switching back is
 * instant; tabs behind hold no socket and no WebGL context.
 */
export function TerminalArea({ active, sessionIds, agents, onView, searching, onSearchEnd }: Props) {
  const platform = useContext(ServerPlatform);
  const container = useRef<HTMLDivElement>(null);
  const sessions = useRef(new Map<string, { session: TerminalSession; element: HTMLDivElement }>());
  const report = useRef(onView);
  report.current = onView;
  const agentsNow = useRef(agents);
  agentsNow.current = agents;
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
      entry = { element, session: new TerminalSession(id, element, (view) => report.current(id, view), { agent: agentsNow.current.has(id), platform }) };
      open.set(active, entry);
    }
    entry.element.hidden = false;
    entry.session.activate();
  }, [active, openIds, platform]);

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

  const current = active === undefined ? undefined : sessions.current.get(active)?.session;
  // Look up on interaction: the active session is created in an effect, after the first render.
  const sendKey = (key: TerminalKey) => {
    if (active !== undefined && !searching) sessions.current.get(active)?.session.sendKey(key);
  };
  const keyboard = () => {
    if (active !== undefined && !searching) sessions.current.get(active)?.session.focus();
  };
  return (
    <div className="terminals-wrap">
      <div ref={container} className="terminals" />
      {searching && current && <SearchBox session={current} onEnd={onSearchEnd} />}
      {active !== undefined && <TerminalKeys disabled={searching} onKey={sendKey} onKeyboard={keyboard} />}
    </div>
  );
}

/** Windows Terminal's find box: Enter finds down, Shift+Enter up, Esc closes. */
function SearchBox({ session, onEnd }: { session: TerminalSession; onEnd: () => void }) {
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  const find = (value: string, backwards = false) => setMissing(value !== '' && !session.find(value, backwards));
  const close = () => {
    session.endFind();
    onEnd();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter') find(text, event.shiftKey);
    else return;
    event.preventDefault();
  };
  return (
    <div className="search-box" role="search">
      <input
        autoFocus
        aria-label="查找"
        placeholder="查找"
        className={missing ? 'missing' : ''}
        value={text}
        onKeyDown={key}
        onChange={(event) => {
          setText(event.target.value);
          find(event.target.value);
        }}
      />
      <button type="button" aria-label="上一个" onClick={() => find(text, true)}>
        ↑
      </button>
      <button type="button" aria-label="下一个" onClick={() => find(text)}>
        ↓
      </button>
      <button type="button" aria-label="关闭查找" onClick={close}>
        ×
      </button>
    </div>
  );
}
