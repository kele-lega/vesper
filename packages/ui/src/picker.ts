import type { SessionInfo, ShellKind } from '@vesper/protocol';
import { api, UnauthorizedError } from './api.js';
import { byId, el } from './dom.js';

const SHELL_NAMES: Record<ShellKind, string> = { powershell: 'PowerShell', cmd: '命令提示符', gitbash: 'Git Bash' };
const REFRESH_MS = 2000;

/** The session list: open, create and close sessions. Each session opens as its own page. */
export async function showPicker(): Promise<void> {
  byId('picker').hidden = false;
  byId('title').textContent = 'Vesper · 会话';
  const form = byId<HTMLFormElement>('create');
  const shell = byId<HTMLSelectElement>('shell');
  const cwd = byId<HTMLInputElement>('cwd');
  const message = byId('message');

  try {
    const config = await api<{ defaultCwd: string; shells: ShellKind[] }>('GET', '/api/config');
    for (const kind of config.shells) shell.append(new Option(SHELL_NAMES[kind], kind));
    cwd.value = config.defaultCwd;
  } catch (error) {
    if (error instanceof UnauthorizedError) return showTokenHelp();
    message.textContent = `无法读取配置：${(error as Error).message}`;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    message.textContent = '正在启动…';
    api<{ session: SessionInfo }>('POST', '/api/sessions', { shell: shell.value, cwd: cwd.value.trim() || undefined }).then(
      ({ session }) => location.assign(`/s/${encodeURIComponent(session.id)}`),
      (error: Error) => (message.textContent = `无法新建：${error.message}`),
    );
  });

  let shown = '';
  const refresh = async () => {
    try {
      const { sessions } = await api<{ sessions: SessionInfo[] }>('GET', '/api/sessions');
      const next = JSON.stringify(sessions);
      if (next !== shown) {
        shown = next;
        renderList(sessions, refresh);
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) return showTokenHelp();
      message.textContent = `无法读取会话：${(error as Error).message}`;
    }
  };
  await refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

function renderList(sessions: SessionInfo[], refresh: () => Promise<void>): void {
  const list = byId('sessions');
  list.replaceChildren(...sessions.map((session) => row(session, refresh)));
  if (sessions.length === 0) list.append(el('li', 'empty', '还没有会话。选一个 shell 和目录，然后新建。'));
}

function row(session: SessionInfo, refresh: () => Promise<void>): HTMLLIElement {
  const item = el('li', 'session');
  const link = el('a', 'open');
  link.href = `/s/${encodeURIComponent(session.id)}`;
  const state = session.status === 'running' ? '运行中' : `已退出（${session.exitCode ?? '?'}）`;
  const viewers = session.attached > 0 ? ` · ${session.attached} 个窗口` : '';
  link.append(
    el('span', `dot ${session.status === 'running' ? 'online' : ''}`),
    el('span', 'name', session.title),
    el('span', 'meta', `${SHELL_NAMES[session.shell]} · ${session.cwd}`),
    el('span', 'meta', state + viewers),
  );
  const close = el('button', 'close', '关闭');
  close.type = 'button';
  close.setAttribute('aria-label', `关闭 ${session.title}`);
  close.addEventListener('click', () => {
    if (session.status === 'running' && !confirm(`关闭“${session.title}”？其中的 shell 会被结束。`)) return;
    void api('DELETE', `/api/sessions/${encodeURIComponent(session.id)}`).then(refresh, (error: Error) => {
      byId('message').textContent = `无法关闭：${error.message}`;
    });
  });
  item.append(link, close);
  return item;
}

export function showTokenHelp(): void {
  byId('picker').hidden = false;
  byId('create').hidden = true;
  byId('sessions').replaceChildren();
  byId('message').textContent = '需要访问令牌：请用 vesper-web 启动时打印的链接（带 #token=）打开本页。';
}
