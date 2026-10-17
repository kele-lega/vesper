/** The pages: home, a project (the unsorted tabs live under "unsorted"), and the old /s/<id> links. */
export type Route =
  | { page: 'home' }
  | { page: 'settings' }
  | { page: 'project'; projectId: string | null; sessionId?: string }
  | { page: 'session'; sessionId: string };

export const UNSORTED = 'unsorted';
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === '/settings') return { page: 'settings' };
  const [, kind, id, extra] = pathname.split('/');
  if (extra !== undefined || id === undefined || !ID.test(id)) return { page: 'home' };
  if (kind === 's') return { page: 'session', sessionId: id };
  if (kind !== 'p') return { page: 'home' };
  const tab = new URLSearchParams(search).get('tab');
  return { page: 'project', projectId: id === UNSORTED ? null : id, ...(tab !== null && ID.test(tab) ? { sessionId: tab } : {}) };
}

export function projectPath(projectId: string | null, sessionId?: string): string {
  const base = `/p/${encodeURIComponent(projectId ?? UNSORTED)}`;
  return sessionId ? `${base}?tab=${encodeURIComponent(sessionId)}` : base;
}
