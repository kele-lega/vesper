import type { DatabaseSync } from 'node:sqlite';

const DEFAULT_CWD = 'default_cwd';

/** Settings changed from the settings page; each falls back to the server's configuration. */
export class SettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly fallbackCwd: string,
  ) {}

  defaultCwd(): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(DEFAULT_CWD) as { value: string } | undefined;
    return row?.value ?? this.fallbackCwd;
  }

  setDefaultCwd(path: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(DEFAULT_CWD, path);
  }
}
