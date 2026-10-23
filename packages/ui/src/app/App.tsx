import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, UnauthorizedError } from '../api.js';
import { tabsOf } from './control-state.js';
import { ControlStore } from './control-store.js';
import { alertNotice, setBadge } from './notices.js';
import { Home } from './Home.js';
import { Login } from './Login.js';
import { ProjectPage } from './ProjectPage.js';
import { navigate, useRoute } from './router.js';
import { projectPath } from './routes.js';
import { Settings } from './Settings.js';
import { ServerPlatform, type ServerConfig } from './platform.js';

type Auth = { phase: 'checking' } | { phase: 'out'; passwordSet: boolean } | { phase: 'in' } | { phase: 'error'; reason: string };

export function App() {
  const [auth, setAuth] = useState<Auth>({ phase: 'checking' });

  const check = useCallback(async () => {
    try {
      const session = await api<{ loggedIn: boolean; passwordSet: boolean }>('GET', '/api/session');
      setAuth(session.loggedIn ? { phase: 'in' } : { phase: 'out', passwordSet: session.passwordSet });
    } catch (failure) {
      // /api/session answers 200 either way; anything else is a server that is down, or an older Vesper.
      const reason =
        failure instanceof UnauthorizedError || failure instanceof ApiError
          ? '服务器的版本和这个页面不一致：可能还有旧版 Vesper 在运行，请停掉它并重新启动 npm run demo。'
          : '连不上 Vesper 服务器，请稍后刷新。';
      setAuth({ phase: 'error', reason });
    }
  }, []);

  useEffect(() => void check(), [check]);

  if (auth.phase === 'checking') return null;
  if (auth.phase === 'error') return <main className="center">{auth.reason}</main>;
  if (auth.phase === 'out') return <Login passwordSet={auth.passwordSet} onLoggedIn={() => setAuth({ phase: 'in' })} />;
  return <LoggedIn onLoggedOut={() => void check()} />;
}

function LoggedIn({ onLoggedOut }: { onLoggedOut: () => void }) {
  const store = useMemo(() => new ControlStore(), []);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const route = useRoute();
  const [config, setConfig] = useState<ServerConfig>();
  const [configError, setConfigError] = useState('');

  useEffect(() => {
    let active = true;
    void api<ServerConfig>('GET', '/api/config').then(
      (next) => active && setConfig(next),
      (failure: unknown) => active && setConfigError(failure instanceof ApiError ? failure.message : '读取服务器平台失败，请刷新重试。'),
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  useEffect(() => {
    if (view.status === 'unauthorized') onLoggedOut();
  }, [view.status, onLoggedOut]);

  // New notices alert from any page; the tab in front is the one in the URL, else the project's first.
  const latest = useRef({ state: view.state, route });
  latest.current = { state: view.state, route };
  useEffect(
    () =>
      store.onNotice((notice) => {
        const { state, route: now } = latest.current;
        if (!state) return;
        const active = now.page !== 'project' ? undefined : (now.sessionId ?? tabsOf(state, now.projectId)[0]?.tab.sessionId);
        alertNotice(state, notice, active);
      }),
    [store],
  );
  const unread = view.state?.notices.length ?? 0;
  useEffect(() => setBadge(unread), [unread]);

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

  if (configError) return <main className="center" role="alert">{configError}</main>;
  if (!view.state || !config) return <main className="center">{view.status === 'offline' ? '连接已断开，正在重连…' : '连接中…'}</main>;
  const page = route.page === 'project'
    ? <ProjectPage state={view.state} projectId={route.projectId} sessionId={route.sessionId} online={view.status === 'online'} />
    : route.page === 'settings' ? <Settings /> : <Home state={view.state} online={view.status === 'online'} onLogout={() => void logout()} />;
  return <ServerPlatform.Provider value={config.platform}>{page}</ServerPlatform.Provider>;
}
