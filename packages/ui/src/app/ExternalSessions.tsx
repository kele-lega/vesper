import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { navigate } from './router.js';
import { projectPath } from './routes.js';

interface External {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  name: string;
}

const REFRESH_MS = 10_000;

/** Claude sessions running outside Vesper, each with a button that moves it into a tab (design.md §7.4). */
export function ExternalSessions() {
  const [sessions, setSessions] = useState<External[]>([]);
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ sessions: External[] }>('GET', '/api/external')
        .then((reply) => alive && setSessions(reply.sessions))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const takeOver = async (entry: External) => {
    if (!confirm(`接管“${entry.name || entry.cwd}”？原来的 Claude 窗口会被关闭，对话在 Vesper 里用 --resume 继续。`)) return;
    setBusy(entry.pid);
    setError('');
    try {
      const { session, projectId } = await api<{ session: { id: string }; projectId: string | null }>('POST', '/api/external/take-over', { pid: entry.pid, sessionId: entry.sessionId });
      setSessions((current) => current.filter((other) => other.pid !== entry.pid));
      navigate(projectPath(projectId, session.id));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : '接管失败');
    } finally {
      setBusy(undefined);
    }
  };

  if (sessions.length === 0 && !error) return null;
  return (
    <section className="external" aria-label="外部会话">
      <h2>外部会话</h2>
      {sessions.map((entry) => (
        <div className="external-row" key={entry.pid}>
          <span className={`dot ${entry.status === 'idle' ? 'agent-idle' : 'agent-working'}`} title={entry.status === 'idle' ? '空闲' : '工作中'} />
          <span className="external-name">{entry.name || 'Claude'}</span>
          <span className="muted mono" title={entry.cwd}>
            {entry.cwd}
          </span>
          <button type="button" disabled={busy !== undefined || entry.status !== 'idle'} onClick={() => void takeOver(entry)}>
            {entry.status === 'idle' ? '接管' : '工作中'}
          </button>
        </div>
      ))}
      <p className="error" role="alert">
        {error}
      </p>
    </section>
  );
}
