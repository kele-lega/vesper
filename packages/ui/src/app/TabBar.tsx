import type { ProfileInfo, SessionInfo } from '@vesper/protocol';
import { useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { tabTitle, type TabEntry } from './control-state.js';
import { useDragReorder } from './reorder.js';

interface Props {
  tabs: TabEntry[];
  active: string | undefined;
  profiles: ProfileInfo[];
  status: string;
  onSelect: (sessionId: string) => void;
  onClose: (entry: TabEntry) => void;
  onRename: (sessionId: string, name: string) => void;
  onReorder: (sessionIds: readonly string[]) => void;
  onNew: (profileId: string) => void;
  onHome: (event: MouseEvent) => void;
  bell: ReactNode;
}

const AGENT_STATES: Record<string, string> = { idle: '空闲', working: '工作中', waiting: '等待确认', done: '已完成' };

/** An agent's state while it runs; otherwise running or ended. */
function dotClass(session: SessionInfo): string {
  if (session.status !== 'running') return '';
  return session.agent ? `agent-${session.agent.state}` : 'online';
}

function dotTitle(session: SessionInfo): string {
  if (session.status !== 'running') return '已结束';
  return session.agent ? AGENT_STATES[session.agent.state] ?? '' : '运行中';
}

/** Windows Terminal's tab row: status dot and title per tab, + for the first profile, ⌄ for the rest. */
export function TabBar({ tabs, active, profiles, status, onSelect, onClose, onRename, onReorder, onNew, onHome, bell }: Props) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const { dragging, itemProps } = useDragReorder(
    tabs.map(({ tab }) => tab.sessionId),
    onReorder,
  );
  const first = profiles[0];

  return (
    <header className="tabbar">
      <nav className="tabs" aria-label="标签页">
        <a className="home" href="/" onClick={onHome} aria-label="全部项目">
          ≡
        </a>
        {tabs.map((entry) => {
          const id = entry.tab.sessionId;
          const title = tabTitle(entry.tab, entry.session);
          return (
            <div
              key={id}
              className={`tab ${id === active ? 'active' : ''} ${id === dragging ? 'dragging' : ''}`}
              role="tab"
              aria-selected={id === active}
              tabIndex={0}
              title={`${title}\n${entry.session.cwd}`}
              onClick={() => onSelect(id)}
              onAuxClick={(event) => event.button === 1 && onClose(entry)}
              onDoubleClick={() => setRenaming(id)}
              onKeyDown={(event) => event.key === 'Enter' && onSelect(id)}
              {...itemProps(id)}
            >
              <span className={`dot ${dotClass(entry.session)}`} title={dotTitle(entry.session)} />
              {renaming === id ? (
                <RenameBox
                  initial={entry.tab.name || entry.session.title}
                  onDone={(name) => {
                    setRenaming(undefined);
                    if (name !== undefined) onRename(id, name);
                  }}
                />
              ) : (
                <span className="tab-title">{title}</span>
              )}
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭 ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(entry);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button type="button" className="tab-new" disabled={!first} onClick={() => first && onNew(first.id)} aria-label={first ? `新建 ${first.name}` : '新建标签页'}>
          ＋
        </button>
        <div className="menu-anchor">
          <button type="button" className="tab-new" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} aria-label="选择 profile">
            ⌄
          </button>
          {menu && (
            <ul className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              {profiles.map((profile) => (
                <li key={profile.id} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onNew(profile.id);
                    }}
                  >
                    {profile.name}
                    {profile.elevation === 'admin' && <span className="badge">管理员</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>
      <div className="status" role="status">
        {status}
      </div>
      {bell}
    </header>
  );
}

/** Enter or leaving the box saves, Escape cancels; whichever comes first counts. */
function RenameBox({ initial, onDone }: { initial: string; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState(initial);
  const finished = useRef(false);
  const done = (result: string | undefined) => {
    if (finished.current) return;
    finished.current = true;
    onDone(result);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    done(name);
  };
  return (
    <form onSubmit={submit} onClick={(event) => event.stopPropagation()}>
      <input
        className="tab-rename"
        aria-label="标签名"
        value={name}
        autoFocus
        onFocus={(event) => event.target.select()}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => done(name)}
        onKeyDown={(event) => event.key === 'Escape' && done(undefined)}
      />
    </form>
  );
}
