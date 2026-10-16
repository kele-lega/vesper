import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { AuthStore, DEVICE_TOUCH_MS, SESSION_MS } from '../src/auth-store.js';
import { openWebDatabase } from '../src/web-db.js';

describe('AuthStore', () => {
  const dirs: string[] = [];
  const dbs: DatabaseSync[] = [];
  let clock = 1_000_000;
  const open = (dir = mkdtempSync(join(tmpdir(), 'vesper-web-db-'))) => {
    if (!dirs.includes(dir)) dirs.push(dir);
    const db = openWebDatabase(join(dir, 'data', 'vesper.db'));
    dbs.push(db);
    return { store: new AuthStore(db, () => clock), dir, db };
  };

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    clock = 1_000_000;
  });

  test('has no password until one is set, and keeps it across reopening', () => {
    const { store, dir, db } = open();
    expect(store.passwordHash()).toBeUndefined();
    store.setPasswordHash('scrypt$hash');
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
    expect(open(dir).store.passwordHash()).toBe('scrypt$hash');
  });

  test('a device token authenticates; the database keeps only its hash', () => {
    const { store, db } = open();
    const { token, device } = store.createDevice('Edge · Windows', '203.0.113.5');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.authenticate(token, '203.0.113.5')).toEqual({ device, renewed: false });
    expect(store.authenticate(`${token.slice(0, -1)}x`, '203.0.113.5')).toBeUndefined();
    expect(store.authenticate('not a token', '203.0.113.5')).toBeUndefined();
    const stored = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(stored).not.toContain(token);
  });

  test('sliding expiry: use renews the session at most once per touch interval', () => {
    const { store } = open();
    const { token, device } = store.createDevice('phone', '198.51.100.1');
    expect(device.expiresAt).toBe(clock + SESSION_MS);
    clock += DEVICE_TOUCH_MS - 1;
    expect(store.authenticate(token, '198.51.100.1')?.renewed).toBe(false);
    clock += 2;
    const renewed = store.authenticate(token, '198.51.100.2');
    expect(renewed).toMatchObject({ renewed: true, device: { lastIp: '198.51.100.2', lastSeenAt: clock, expiresAt: clock + SESSION_MS } });
  });

  test('an expired session no longer authenticates and is deleted', () => {
    const { store, db } = open();
    const { token } = store.createDevice('laptop', '127.0.0.1');
    clock += SESSION_MS;
    expect(store.authenticate(token, '127.0.0.1')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });

  test('logging out revokes one device; a new password revokes them all', () => {
    const { store } = open();
    const first = store.createDevice('a', '127.0.0.1');
    const second = store.createDevice('b', '127.0.0.1');
    const third = store.createDevice('c', '127.0.0.1');
    store.revoke(first.device.id);
    expect(store.authenticate(first.token, '127.0.0.1')).toBeUndefined();
    expect(store.authenticate(second.token, '127.0.0.1')).toBeDefined();
    store.setPasswordHash('scrypt$new');
    expect(store.authenticate(second.token, '127.0.0.1')).toBeUndefined();
    expect(store.authenticate(third.token, '127.0.0.1')).toBeUndefined();
  });

  test('bounds the stored device name and address', () => {
    const { store } = open();
    const { device } = store.createDevice('x'.repeat(1000), 'y'.repeat(1000));
    expect(device.name).toHaveLength(256);
    expect(device.lastIp).toHaveLength(64);
  });
});

describe('openWebDatabase', () => {
  test('refuses a database from a newer version', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'vesper-web-db-'));
    try {
      const path = join(dir, 'vesper.db');
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA user_version = 99');
      raw.close();
      expect(() => openWebDatabase(path)).toThrow(/schema v99/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
