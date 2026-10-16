import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../api.js';
import { ControlStore } from './control-store.js';
import { Home } from './Home.js';
import { Login } from './Login.js';
import { ProjectPage } from './ProjectPage.js';
import { navigate, useRoute } from './router.js';
import { projectPath } from './routes.js';

type Auth = { phase: 'checking' } | { phase: 'out'; passwordSet: boolean } | { phase: 'in' } | { phase: 'error' };

export function App() {
  const [auth, setAuth] = useState<Auth>({ phase: 'checking' });

  const check = useCallback(async () => {
    try {
      const session = await api<{ loggedIn: boolean; passwordSet: boolean }>('GET', '/api/session');
      setAuth(session.loggedIn ? { phase: 'in' } : { phase: 'out', passwordSet: session.passwordSet });
    } catch {
      setAuth({ phase: 'error' });
    }
  }, []);

  useEffect(() => void check(), [check]);

  if (auth.phase === 'checking') return null;
  if (auth.phase === 'error') return <main className="center">连不上 Vesper 服务器，请稍后刷新。</main>;
  if (auth.phase === 'out') return <Login passwordSet={auth.passwordSet} onLoggedIn={() => setAuth({ phase: 'in' })} />;
  return <LoggedIn onLoggedOut={() => void check()} />;
}

function LoggedIn({ onLoggedOut }: { onLoggedOut: () => void }) {
  const store = useMemo(() => new ControlStore(), []);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const route = useRoute();

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  useEffect(() => {
    if (view.status === 'unauthorized') onLoggedOut();
  }, [view.status, onLoggedOut]);

  // Old /s/<id> links open the session's tab in its project.
  useEffect(() => {
    if (route.page !== 'session' || !view.state) return;
    const tab = view.state.tabs.find((entry) => entry.sessionId === route.sessionId);
    navigate(tab ? projectPath(tab.projectId, tab.sessionId) : '/', true);
  }, [route, view.state]);

  const logout = async () => {
    await api('POST', '/api/logout').catch(() => undefined);
    onLoggedOut();
  };

  if (!view.state) return <main className="center">{view.status === 'offline' ? '连接已断开，正在重连…' : '连接中…'}</main>;
  if (route.page === 'project') return <ProjectPage state={view.state} projectId={route.projectId} sessionId={route.sessionId} online={view.status === 'online'} />;
  return <Home state={view.state} online={view.status === 'online'} onLogout={() => void logout()} />;
}
