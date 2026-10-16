import type { ControlState } from '@vesper/protocol';
import { useEffect, useState, type MouseEvent } from 'react';
import { api, ApiError } from '../api.js';
import type { SessionView } from '../terminal-session.js';
import { tabsOf, tabTitle, type TabEntry } from './control-state.js';
import { navigate } from './router.js';
import { projectPath } from './routes.js';
import { TabBar } from './TabBar.js';
import { TerminalArea } from './TerminalArea.js';

interface Props {
  state: ControlState;
  /** null: the unsorted tabs. */
  projectId: string | null;
  sessionId: string | undefined;
  online: boolean;
}

export function ProjectPage({ state, projectId, sessionId, online }: Props) {
  const [views, setViews] = useState<ReadonlyMap<string, SessionView>>(new Map());
  const [error, setError] = useState('');
  const project = state.projects.find((entry) => entry.id === projectId);
  const tabs = tabsOf(state, projectId);
  const active = tabs.find(({ tab }) => tab.sessionId === sessionId) ?? tabs[0];
  const activeId = active?.tab.sessionId;
  const projectName = projectId === null ? '未归类' : (project?.name ?? '');

  useEffect(() => {
    document.title = active ? `${tabTitle(active.tab, active.session)} · ${projectName} · Vesper` : `${projectName} · Vesper`;
  }, [active, projectName]);

  useEffect(() => {
    if (projectId !== null && !project) navigate('/', true); // removed, maybe from another device
  }, [projectId, project]);

  const fail = (failure: unknown) => setError(failure instanceof ApiError ? failure.message : '操作失败');
  const select = (id: string) => navigate(projectPath(projectId, id), true);

  const create = async (profileId: string) => {
    setError('');
    try {
      const { session } = await api<{ session: { id: string } }>('POST', '/api/tabs', { projectId, profileId });
      select(session.id);
    } catch (failure) {
      fail(failure);
    }
  };

  const close = async ({ tab, session }: TabEntry) => {
    if (session.status === 'running' && !confirm(`关闭“${tabTitle(tab, session)}”？里面运行的程序会被结束。`)) return;
    await api('DELETE', `/api/tabs/${encodeURIComponent(tab.sessionId)}`).catch(fail);
  };

  const restart = (id: string) => void api('POST', `/api/tabs/${encodeURIComponent(id)}/restart`).catch(fail);
  const home = (event: MouseEvent) => {
    event.preventDefault();
    navigate('/');
  };
  const view = activeId === undefined ? undefined : views.get(activeId);
  const status = !online ? '控制连接已断开，正在重连…' : !state.hostOnline ? '终端主机没有响应' : (view?.status ?? '');

  return (
    <div className="page terminal-page">
      <TabBar
        tabs={tabs}
        active={activeId}
        profiles={state.profiles}
        status={error || status}
        onSelect={select}
        onClose={(entry) => void close(entry)}
        onRename={(id, name) => void api('PATCH', `/api/tabs/${encodeURIComponent(id)}`, { name }).catch(fail)}
        onReorder={(ids) => void api('PUT', '/api/tabs/order', { projectId, sessionIds: ids }).catch(fail)}
        onNew={(profileId) => void create(profileId)}
        onHome={home}
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
        onView={(id, next) => setViews((current) => new Map(current).set(id, next))}
      />
    </div>
  );
}
