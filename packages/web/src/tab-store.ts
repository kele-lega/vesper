import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './web-db.js';

/** Where a ptyd session shows up: its project (null: not sorted yet), place in the tab bar and name. */
export interface Tab {
  sessionId: string;
  projectId: string | null;
  profileId: string | null;
  /** The user's name for the tab; empty shows the session's own title. */
  name: string;
  position: number;
  createdAt: number;
}

export class TabError extends Error {
  constructor(
    readonly code: 'bad_name' | 'not_found' | 'bad_order',
    message: string,
  ) {
    super(message);
  }
}

const MAX_NAME = 100;
const CONTROL = /[\u{0}-\u{1f}\u{7f}]/u;
const COLUMNS = 'session_id AS sessionId, project_id AS projectId, profile_id AS profileId, name, position, created_at AS createdAt';

export class TabStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Tab[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM tabs ORDER BY position, created_at`).all() as unknown as Tab[];
  }

  get(sessionId: string): Tab | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM tabs WHERE session_id = ?`).get(sessionId) as Tab | undefined;
  }

  add(sessionId: string, projectId: string | null, profileId: string | null): Tab {
    return inTransaction(this.db, () => {
      const { next } = this.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tabs WHERE project_id IS ?').get(projectId) as { next: number };
      const tab: Tab = { sessionId, projectId, profileId, name: '', position: next, createdAt: this.now() };
      this.db
        .prepare('INSERT INTO tabs (session_id, project_id, profile_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tab.sessionId, tab.projectId, tab.profileId, tab.name, tab.position, tab.createdAt);
      return tab;
    });
  }

  /** Puts a session's tab at the end of a project; one a sync already adopted is moved there. */
  place(sessionId: string, projectId: string | null, profileId: string | null): Tab {
    return inTransaction(this.db, () => {
      const existing = this.get(sessionId);
      if (!existing) return this.add(sessionId, projectId, profileId);
      const { next } = this.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM tabs WHERE project_id IS ? AND session_id <> ?').get(projectId, sessionId) as { next: number };
      const position = existing.projectId === projectId ? existing.position : next;
      this.db.prepare('UPDATE tabs SET project_id = ?, profile_id = ?, position = ? WHERE session_id = ?').run(projectId, profileId, position, sessionId);
      return { ...existing, projectId, profileId, position };
    });
  }

  rename(sessionId: string, name: string): Tab {
    const trimmed = name.trim();
    if ([...trimmed].length > MAX_NAME || CONTROL.test(trimmed)) throw new TabError('bad_name', `a tab name has at most ${MAX_NAME} characters`);
    if (this.db.prepare('UPDATE tabs SET name = ? WHERE session_id = ?').run(trimmed, sessionId).changes === 0) throw new TabError('not_found', 'no such tab');
    return this.get(sessionId)!;
  }

  /** `sessionIds` must list every tab of the project exactly once, in the new order. */
  reorder(projectId: string | null, sessionIds: readonly string[]): void {
    inTransaction(this.db, () => {
      const rows = this.db.prepare('SELECT session_id AS id FROM tabs WHERE project_id IS ?').all(projectId) as { id: string }[];
      const known = new Set(rows.map((row) => row.id));
      if (sessionIds.length !== known.size || new Set(sessionIds).size !== sessionIds.length || !sessionIds.every((id) => known.has(id))) {
        throw new TabError('bad_order', 'the order must list every tab of the project once');
      }
      const update = this.db.prepare('UPDATE tabs SET position = ? WHERE session_id = ?');
      sessionIds.forEach((id, position) => update.run(position, id));
    });
  }

  remove(sessionId: string): void {
    this.db.prepare('DELETE FROM tabs WHERE session_id = ?').run(sessionId);
  }

  /**
   * Matches the tabs to the sessions ptyd has: a session without a tab (such as one
   * made in M1, or by another client) joins the project its directory is in, and a
   * tab whose session is gone is dropped.
   */
  sync(sessions: readonly { id: string; cwd: string }[], projectFor: (cwd: string) => string | undefined): void {
    const live = new Set(sessions.map((session) => session.id));
    const known = new Set(this.list().map((tab) => tab.sessionId));
    for (const id of known) if (!live.has(id)) this.remove(id);
    for (const session of sessions) if (!known.has(session.id)) this.add(session.id, projectFor(session.cwd) ?? null, null);
  }
}
