import type { DatabaseSync } from 'node:sqlite';

/** Rows kept; older ones are deleted as new ones arrive, so a flood of failed logins cannot fill the disk. */
const MAX_KEPT = 5000;
const MAX_DETAIL = 500;
const MAX_IP = 64;
export const DEFAULT_AUDIT_PAGE = 200;

export const AUDIT_KINDS = [
  'login',
  'login_failed',
  'logout',
  'device_revoked',
  'session_created',
  'session_closed',
  'session_taken_over',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  id: number;
  at: number;
  kind: AuditKind;
  /** The device that did it; null for a failed login or a change made from the CLI. */
  device: string | null;
  ip: string;
  detail: string;
}

const COLUMNS = 'id, at, kind, device, ip, detail';

/** Who did what and from where (design.md §8): logins, devices, sessions starting, ending and being taken over. */
export class AuditStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  add(kind: AuditKind, who: { device?: string | null; ip?: string }, detail = ''): void {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO audit (at, kind, device, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .run(this.now(), kind, who.device ?? null, (who.ip ?? '').slice(0, MAX_IP), detail.slice(0, MAX_DETAIL));
    this.db.prepare('DELETE FROM audit WHERE id <= ?').run(Number(lastInsertRowid) - MAX_KEPT);
  }

  /** Newest first. */
  recent(limit = DEFAULT_AUDIT_PAGE): AuditEntry[] {
    const count = Math.max(1, Math.min(Math.trunc(limit), MAX_KEPT));
    return this.db.prepare(`SELECT ${COLUMNS} FROM audit ORDER BY id DESC LIMIT ?`).all(count) as unknown as AuditEntry[];
  }
}
