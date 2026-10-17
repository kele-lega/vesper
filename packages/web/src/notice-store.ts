import type { DatabaseSync } from 'node:sqlite';
import type { NoticeInfo, NoticeKind } from '@vesper/protocol';

/** Rows kept, read or not; older ones are deleted as new ones arrive. */
const MAX_KEPT = 1000;
/** Unread notices sent to pages; a flood beyond this shows only the newest. */
const MAX_UNREAD = 200;

interface Row {
  id: number;
  session_id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  at: number;
}

/** Notices from every session; "read" is shared by all devices. */
export class NoticeStore {
  constructor(private readonly db: DatabaseSync) {}

  add(notice: Omit<NoticeInfo, 'id'>): NoticeInfo {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (session_id, kind, title, body, at) VALUES (?, ?, ?, ?, ?)')
      .run(notice.session, notice.kind, notice.title, notice.body, notice.at);
    const id = Number(lastInsertRowid);
    this.db.prepare('DELETE FROM events WHERE id <= ?').run(id - MAX_KEPT);
    return { id, ...notice };
  }

  /** Newest first. */
  unread(): NoticeInfo[] {
    const rows = this.db
      .prepare('SELECT id, session_id, kind, title, body, at FROM events WHERE read = 0 ORDER BY id DESC LIMIT ?')
      .all(MAX_UNREAD) as unknown as Row[];
    return rows.map((row) => ({ id: row.id, session: row.session_id, kind: row.kind, title: row.title, body: row.body, at: row.at }));
  }

  /** Marks the given notices, every notice of a session, or all of them; returns whether anything changed. */
  markRead(selector: { ids: number[] } | { session: string } | { all: true }): boolean {
    if ('all' in selector) return this.db.prepare('UPDATE events SET read = 1 WHERE read = 0').run().changes > 0;
    if ('session' in selector) return this.db.prepare('UPDATE events SET read = 1 WHERE read = 0 AND session_id = ?').run(selector.session).changes > 0;
    const mark = this.db.prepare('UPDATE events SET read = 1 WHERE read = 0 AND id = ?');
    let changed = 0;
    for (const id of selector.ids) changed += Number(mark.run(id).changes);
    return changed > 0;
  }

  /** A closed tab's notices go with it. */
  forget(session: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(session);
  }
}
