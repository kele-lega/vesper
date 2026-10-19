import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './web-db.js';

/** A login lasts this long after its last use (sliding). */
export const SESSION_MS = 30 * 24 * 3600_000;
/** Use is recorded, and the expiry pushed back, at most this often per device. */
export const DEVICE_TOUCH_MS = 3600_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_NAME = 256;
const MAX_IP = 64;

/** One browser's login. The cookie holds a random token; only its SHA-256 is stored. */
export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  expiresAt: number;
}

const DEVICE_COLUMNS = 'id, name, created_at AS createdAt, last_seen_at AS lastSeenAt, last_ip AS lastIp, expires_at AS expiresAt';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export class AuthStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  passwordHash(): string | undefined {
    const row = this.db.prepare('SELECT password_hash AS hash FROM auth WHERE id = 1').get() as { hash: string } | undefined;
    return row?.hash;
  }

  /** A new password signs every device out. */
  setPasswordHash(hash: string): void {
    inTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO auth (id, password_hash, changed_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, changed_at = excluded.changed_at')
        .run(hash, this.now());
      this.db.prepare('DELETE FROM devices').run();
    });
  }

  createDevice(name: string, ip: string): { token: string; device: Device } {
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const device: Device = {
      id: randomBytes(12).toString('base64url'),
      name: name.slice(0, MAX_NAME),
      createdAt: now,
      lastSeenAt: now,
      lastIp: ip.slice(0, MAX_IP),
      expiresAt: now + SESSION_MS,
    };
    this.db.prepare('DELETE FROM devices WHERE expires_at <= ?').run(now);
    this.db
      .prepare('INSERT INTO devices (id, token_hash, name, created_at, last_seen_at, last_ip, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(device.id, tokenHash(token), device.name, device.createdAt, device.lastSeenAt, device.lastIp, device.expiresAt);
    return { token, device };
  }

  /** The device a cookie token belongs to; renewed says the expiry moved, so the cookie should be sent again. */
  authenticate(token: string, ip: string): { device: Device; renewed: boolean } | undefined {
    if (!TOKEN.test(token)) return undefined;
    const device = this.db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?`).get(tokenHash(token)) as Device | undefined;
    if (!device) return undefined;
    const now = this.now();
    if (now >= device.expiresAt) {
      this.revoke(device.id);
      return undefined;
    }
    if (now - device.lastSeenAt < DEVICE_TOUCH_MS) return { device: { ...device }, renewed: false };
    const touched = { ...device, lastSeenAt: now, lastIp: ip.slice(0, MAX_IP), expiresAt: now + SESSION_MS };
    this.db
      .prepare('UPDATE devices SET last_seen_at = ?, last_ip = ?, expires_at = ? WHERE id = ?')
      .run(touched.lastSeenAt, touched.lastIp, touched.expiresAt, touched.id);
    return { device: touched, renewed: true };
  }

  revoke(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  /** Logged-in devices, most recently used first. */
  list(): Device[] {
    return this.db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE expires_at > ? ORDER BY last_seen_at DESC`).all(this.now()) as unknown as Device[];
  }

  /** Whether a device existed (and so was signed out). */
  revokeKnown(id: string): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
  }

  /** Whether the device is still logged in and its login has not expired. */
  hasDevice(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM devices WHERE id = ? AND expires_at > ?').get(id, this.now()) !== undefined;
  }
}
