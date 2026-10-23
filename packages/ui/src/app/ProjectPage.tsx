import type { ControlState } from '@vesper/protocol';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api, ApiError } from '../api.js';
import { isPageShortcut, type SessionView } from '../terminal-session.js';
import { FullscreenButton } from './FullscreenButton.js';
import { tabsOf, tabTitle, type TabEntry } from './control-state.js';
import { NoticeBell } from './NoticeBell.js';
import { markRead, titled } from './notices.js';
import { navigate } from './router.js';
import { projectPath } from './routes.js';
import { TabBar } from './TabBar.js';
import { TerminalArea } from './TerminalArea.js';
import { useTerminalViewport } from './terminal-viewport.js';

interface Props {
  state: ControlState;
  /** null: the unsorted tabs. */
  projectId: string | null;
  sessionId: string | undefined;
  online: boolean;
}

export function ProjectPage({ state, projectId, sessionId, online }: Props) {
  const page = useTerminalViewport();
  const [views, setViews] = useState<ReadonlyMap<string, SessionView>>(new Map());
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const project = state.projects.find((entry) => entry.id === projectId);
  const tabs = tabsOf(state, projectId);
  const active = tabs.find(({ tab }) => tab.sessionId === sessionId) ?? tabs[0];
  const activeId = active?.tab.sessionId;
  const projectName = projectId === null ? '未归类' : (project?.name ?? '');

  useEffect(() => {
    const title = active ? `${tabTitle(active.tab, active.session)} · ${projectName} · Vesper` : `${projectName} · Vesper`;
    document.title = titled(title, state.notices.length);
  }, [active, projectName, state.notices.length]);

  // The tab in front of a page in view has been seen.
  const unreadHere = state.notices.some((notice) => notice.session === activeId);
  useEffect(() => {
    if (!activeId || !unreadHere) return;
    const read = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) markRead({ session: activeId });
    };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [activeId, unreadHere]);

  useEffect(() => {
    if (projectId !== null && !project) navigate('/', true); // removed, maybe from another device
  }, [projectId, project]);

  const fail = (failure: unknown) => setError(failure instanceof ApiError ? failure.message : '操作失败');
  const select = (id: string) => navigate(projectPath(projectId, id), true);

  const create = async (profileId: string, worktree?: boolean) => {
    setError('');
    let name: string | null = null;
    if (worktree) {
      name = prompt('worktree 名称（分支为 vesper/名称）：', `agent-${new Date().toISOString().slice(5, 16).replace(/\D/g, '')}`);
      if (name === null) return;
    }
    try {
      const { session } = await api<{ session: { id: string } }>('POST', '/api/tabs', { projectId, profileId, ...(name === null ? {} : { worktree: name.trim() }) });
      select(session.id);
    } catch (failure) {
      fail(failure);
    }
  };

  const close = async ({ tab, session }: TabEntry) => {
    if (session.status === 'running' && !confirm(`关闭“${tabTitle(tab, session)}”？里面运行的程序会被结束。`)) return;
    const removeWorktree = tab.branch !== null && confirm(`同时删除这个标签的 worktree（分支 ${tab.branch}）？\n有未提交的改动时会保留；分支有未合并的提交时也会保留。`);
    try {
      const reply = await api<{ worktree?: { note: string } }>('DELETE', `/api/tabs/${encodeURIComponent(tab.sessionId)}${removeWorktree ? '?removeWorktree=1' : ''}`);
      if (reply?.worktree?.note) setError(reply.worktree.note);
    } catch (failure) {
      fail(failure);
    }
  };

  const restart = (id: string) => void api('POST', `/api/tabs/${encodeURIComponent(id)}/restart`).catch(fail);
  const home = (event: MouseEvent) => {
    event.preventDefault();
    navigate('/');
  };
  const view = activeId === undefined ? undefined : views.get(activeId);
  const status = !online ? '控制连接已断开，正在重连…' : !state.hostOnline ? '终端主机没有响应' : (view?.status ?? '');
  const agentProfiles = new Set(state.profiles.filter((profile) => profile.agent !== null).map((profile) => profile.id));
  const agents = new Set(tabs.filter(({ tab }) => tab.profileId !== null && agentProfiles.has(tab.profileId)).map(({ tab }) => tab.sessionId));

  // Ctrl+Shift+T new tab (first profile), Ctrl+Shift+W close, Ctrl+Shift+F find, Ctrl+(Shift+)Tab next/previous.
  const shortcut = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcut.current = (event) => {
    if (!isPageShortcut(event) || event.type !== 'keydown') return;
    event.preventDefault();
    const key = event.code;
    if (key === 'Tab') {
      const index = tabs.findIndex(({ tab }) => tab.sessionId === activeId);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (next) select(next.tab.sessionId);
    } else if (key === 'KeyT' && state.profiles[0]) void create(state.profiles[0].id);
    else if (key === 'KeyW' && active) void close(active);
    else if (key === 'KeyF' && active) setSearching(true);
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcut.current(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  return (
    <div ref={page} className="page terminal-page">
      <TabBar
        tabs={tabs}
        active={activeId}
        profiles={state.profiles}
        status={error || status}
        onSelect={select}
        onClose={(entry) => void close(entry)}
        onRename={(id, name) => void api('PATCH', `/api/tabs/${encodeURIComponent(id)}`, { name }).catch(fail)}
        onReorder={(ids) => void api('PUT', '/api/tabs/order', { projectId, sessionIds: ids }).catch(fail)}
        onNew={(profileId, worktree) => void create(profileId, worktree)}
        canWorktree={projectId !== null}
        onHome={home}
        bell={
          <>
            <FullscreenButton />
            <NoticeBell state={state} />
          </>
        }
      />
      {active?.session.status === 'exited' && (
        <div className="exit-bar" role="status">
          程序已退出{active.session.exitCode === null ? '' : `（代码 ${active.session.exitCode}）`}
          <button type="button" onClick={() => restart(active.tab.sessionId)}>
            重新启动
          </button>
        </div>
      )}
      {tabs.length === 0 && (
        <main className="empty-project">
          <p>{projectName} 里还没有标签页。</p>
          <div className="profile-buttons">
            {state.profiles.map((profile) => (
              <button type="button" key={profile.id} onClick={() => void create(profile.id)}>
                {profile.name}
              </button>
            ))}
          </div>
        </main>
      )}
      <TerminalArea
        active={activeId}
        sessionIds={tabs.map(({ tab }) => tab.sessionId)}
        agents={agents}
        onView={(id, next) => setViews((current) => new Map(current).set(id, next))}
        searching={searching}
        onSearchEnd={() => setSearching(false)}
      />
    </div>
  );
}
