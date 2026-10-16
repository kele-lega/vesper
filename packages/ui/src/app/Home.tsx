import type { ControlState, ProjectInfo } from '@vesper/protocol';
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { api, ApiError } from '../api.js';
import { projectCounts } from './control-state.js';
import { NewProjectDialog } from './NewProjectDialog.js';
import { useDragReorder } from './reorder.js';
import { navigate } from './router.js';
import { projectPath } from './routes.js';

interface Props {
  state: ControlState;
  online: boolean;
  onLogout: () => void;
}

export function Home({ state, online, onLogout }: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const counts = projectCounts(state);
  const projects = [...state.projects].sort((a, b) => a.position - b.position);
  const { itemProps } = useDragReorder(
    projects.map((project) => project.id),
    (ids) => void api('PUT', '/api/projects/order', { ids }).catch((failure: unknown) => setError(message(failure))),
  );
  const unsorted = counts.get(null);

  useEffect(() => {
    document.title = 'Vesper';
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Vesper</h1>
        <span className={`dot ${online && state.hostOnline ? 'online' : 'offline'}`} />
        <span className="muted">{!online ? '连接已断开，正在重连…' : state.hostOnline ? '' : '终端主机没有响应'}</span>
        <span className="spacer" />
        <button type="button" onClick={onLogout}>
          退出登录
        </button>
      </header>
      <main className="cards">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} count={counts.get(project.id)} dragProps={itemProps(project.id)} onError={setError} />
        ))}
        {unsorted && (
          <a className="card" href={projectPath(null)} onClick={(event) => follow(event, projectPath(null))}>
            <h2>未归类</h2>
            <p className="muted">不属于任何项目的会话</p>
            <Counts count={unsorted} />
          </a>
        )}
        <button type="button" className="card new" onClick={() => setCreating(true)}>
          ＋ 新建项目
        </button>
      </main>
      <p className="error" role="alert">
        {error}
      </p>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={(project) => navigate(projectPath(project.id))} />}
    </div>
  );
}

interface CardProps {
  project: ProjectInfo;
  count: { sessions: number; running: number } | undefined;
  dragProps: object;
  onError: (message: string) => void;
}

function ProjectCard({ project, count, dragProps, onError }: CardProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    setRenaming(false);
    if (name.trim() === project.name) return;
    await api('PATCH', `/api/projects/${encodeURIComponent(project.id)}`, { name }).catch((failure: unknown) => onError(message(failure)));
  };

  const remove = async () => {
    const running = count?.running ?? 0;
    const warning = running > 0 ? `\n\n还有 ${running} 个会话在运行，会被一起关闭。` : '';
    if (!confirm(`从 Vesper 中移除项目“${project.name}”？文件夹本身不会被删除。${warning}`)) return;
    await api('DELETE', `/api/projects/${encodeURIComponent(project.id)}`).catch((failure: unknown) => onError(message(failure)));
  };

  return (
    <div className="card" {...dragProps}>
      {renaming ? (
        <form onSubmit={(event) => void rename(event)}>
          <input aria-label="项目名" value={name} autoFocus onChange={(event) => setName(event.target.value)} onBlur={(event) => void rename(event)} />
        </form>
      ) : (
        <a href={projectPath(project.id)} onClick={(event) => follow(event, projectPath(project.id))}>
          <h2>{project.name}</h2>
        </a>
      )}
      <p className="muted mono" title={project.path}>
        {project.path}
      </p>
      <Counts count={count} />
      <div className="card-actions">
        <button type="button" onClick={() => setRenaming(true)}>
          改名
        </button>
        <button type="button" onClick={() => void remove()}>
          移除
        </button>
      </div>
    </div>
  );
}

function Counts({ count }: { count: { sessions: number; running: number } | undefined }) {
  if (!count) return <p className="muted">没有会话</p>;
  return (
    <p>
      <span className={`dot ${count.running > 0 ? 'online' : ''}`} /> {count.running} 个运行中 · 共 {count.sessions} 个
    </p>
  );
}

function follow(event: MouseEvent, path: string): void {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(path);
}

function message(failure: unknown): string {
  return failure instanceof ApiError ? failure.message : '操作失败';
}
