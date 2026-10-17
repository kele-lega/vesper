import type { ControlMessage, ControlState, SessionInfo, TabInfo } from '@vesper/protocol';

/** The page's copy of the server state: a snapshot, then each change applied without mutating the old state. */
export function applyControl(state: ControlState | undefined, message: ControlMessage): ControlState | undefined {
  if (message.type === 'snapshot') {
    const { type: _, ...snapshot } = message;
    return snapshot;
  }
  if (!state) return undefined;
  switch (message.type) {
    case 'projects':
      return { ...state, projects: message.projects };
    case 'tabs':
      return { ...state, tabs: message.tabs };
    case 'profiles':
      return { ...state, profiles: message.profiles };
    case 'session': {
      const known = state.sessions.some((entry) => entry.id === message.session.id);
      const sessions = known ? state.sessions.map((entry) => (entry.id === message.session.id ? message.session : entry)) : [...state.sessions, message.session];
      return { ...state, sessions };
    }
    case 'removed':
      return { ...state, sessions: state.sessions.filter((entry) => entry.id !== message.session) };
    case 'host':
      return { ...state, hostOnline: message.online };
    case 'notice':
      return { ...state, notices: [message.notice, ...state.notices] };
    case 'notices':
      return { ...state, notices: message.notices };
  }
}

export interface TabEntry {
  tab: TabInfo;
  session: SessionInfo;
}

/** A project's tabs in tab-bar order; a tab whose session the page has not heard of yet is left out. */
export function tabsOf(state: ControlState, projectId: string | null): TabEntry[] {
  const sessions = new Map(state.sessions.map((entry) => [entry.id, entry]));
  return state.tabs
    .filter((tab) => tab.projectId === projectId && sessions.has(tab.sessionId))
    .sort((a, b) => a.position - b.position)
    .map((tab) => ({ tab, session: sessions.get(tab.sessionId)! }));
}

export function tabTitle(tab: TabInfo, session: SessionInfo): string {
  return tab.name || session.title;
}

/** Per project (null: unsorted), how many sessions it has and how many are running. */
export function projectCounts(state: ControlState): Map<string | null, { sessions: number; running: number }> {
  const sessions = new Map(state.sessions.map((entry) => [entry.id, entry]));
  const counts = new Map<string | null, { sessions: number; running: number }>();
  for (const tab of state.tabs) {
    const session = sessions.get(tab.sessionId);
    if (!session) continue;
    const count = counts.get(tab.projectId) ?? { sessions: 0, running: 0 };
    counts.set(tab.projectId, { sessions: count.sessions + 1, running: count.running + (session.status === 'running' ? 1 : 0) });
  }
  return counts;
}
