import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuthStore } from '../src/auth-store.js';
import { deviceName, LoginGate } from '../src/login.js';
import { hashPassword } from '../src/password.js';
import { SESSION_COOKIE, WRITE_HEADER } from '../src/request-auth.js';
import { openWebDatabase } from '../src/web-db.js';

const ORIGIN = 'http://127.0.0.1:7690';
const cheap = { N: 1 << 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

function req(method: string, headers: Record<string, string> = {}, ip = '127.0.0.1'): IncomingMessage {
  return { method, headers: { origin: ORIGIN, [WRITE_HEADER]: '1', ...headers }, socket: { remoteAddress: ip } } as unknown as IncomingMessage;
}
const cookieOf = (setCookie: string | undefined) => setCookie?.split(';')[0] ?? '';

describe('LoginGate', () => {
  let dir: string;
  let db: DatabaseSync;
  let gate: LoginGate;
  const waits: number[] = [];
  const body = (value: unknown) => async () => value;
  const login = (password: string, ip = '127.0.0.1') => gate.route(req('POST', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Edg/140.0' }, ip), '/api/login', body({ password }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vesper-login-'));
    db = openWebDatabase(join(dir, 'vesper.db'));
    new AuthStore(db).setPasswordHash(await hashPassword(PASSWORD, cheap));
    gate = new LoginGate({ db, origins: [ORIGIN], sleep: async (ms) => void waits.push(ms) });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    waits.splice(0);
  });

  test('logging in sets the session cookie, which then authenticates', async () => {
    const reply = await login(PASSWORD);
    expect(reply).toMatchObject({ status: 200, body: { device: { name: 'Edge · Windows' } } });
    expect(reply!.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$`));
    const authed = gate.device(req('GET', { cookie: cookieOf(reply!.cookie) }));
    expect(authed?.device.name).toBe('Edge · Windows');
    expect(gate.device(req('GET'))).toBeUndefined();
  });

  test('a wrong password is refused, and so is a login that fails the write check', async () => {
    const wrong = await login('wrong password!!');
    expect(wrong).toMatchObject({ status: 401 });
    expect(wrong).not.toHaveProperty('cookie');
    expect(await login(42 as unknown as string)).toMatchObject({ status: 400 });
    const foreign = await gate.route(req('POST', { origin: 'https://evil.example' }), '/api/login', body({ password: PASSWORD }));
    expect(foreign).toMatchObject({ status: 403 });
    expect(foreign).not.toHaveProperty('cookie');
  });

  test('throttles repeated attempts from one address with Retry-After', async () => {
    for (let i = 0; i < 5; i++) await login('wrong password!!', '198.51.100.4');
    const throttled = await login(PASSWORD, '198.51.100.4');
    expect(throttled).toMatchObject({ status: 429, retryAfterS: 60 });
    expect((await login(PASSWORD, '198.51.100.5'))?.status).toBe(200);
  });

  test('says when no password has been set yet', async () => {
    const empty = openWebDatabase(join(dir, 'empty.db'));
    try {
      const fresh = new LoginGate({ db: empty, origins: [ORIGIN] });
      expect(await fresh.route(req('GET'), '/api/session', body({}))).toEqual({ status: 200, body: { loggedIn: false, passwordSet: false } });
      expect(await fresh.route(req('POST'), '/api/login', body({ password: PASSWORD }))).toMatchObject({ status: 503 });
    } finally {
      empty.close();
    }
  });

  test('session reports the login; logout ends it and clears the cookie', async () => {
    const cookie = cookieOf((await login(PASSWORD))!.cookie);
    expect(await gate.route(req('GET', { cookie }), '/api/session', body({}))).toMatchObject({ body: { loggedIn: true, passwordSet: true, device: { name: 'Edge · Windows' } } });
    const out = await gate.route(req('POST', { cookie }), '/api/logout', body({}));
    expect(out).toMatchObject({ status: 200, cookie: `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
    expect(gate.device(req('GET', { cookie }))).toBeUndefined();
  });

  test('a WebSocket ticket needs a login and the write check, and works once', async () => {
    const cookie = cookieOf((await login(PASSWORD))!.cookie);
    expect(await gate.route(req('POST'), '/api/ws-ticket', body({}))).toMatchObject({ status: 401 });
    expect(await gate.route(req('POST', { cookie, [WRITE_HEADER]: '' }), '/api/ws-ticket', body({}))).toMatchObject({ status: 403 });
    const reply = await gate.route(req('POST', { cookie }), '/api/ws-ticket', body({}));
    const ticket = (reply!.body as { ticket: string }).ticket;
    const deviceId = gate.device(req('GET', { cookie }))!.device.id;
    expect(gate.redeemTicket(ticket)).toBe(deviceId);
    expect(gate.redeemTicket(ticket)).toBeUndefined();
  });

  test('tickets of a device that logged out, or whose login was revoked elsewhere, do not work', async () => {
    const cookie = cookieOf((await login(PASSWORD))!.cookie);
    const ticket = async () => ((await gate.route(req('POST', { cookie }), '/api/ws-ticket', body({})))!.body as { ticket: string }).ticket;
    const beforePasswordChange = await ticket();
    new AuthStore(db).setPasswordHash(await hashPassword('another passphrase', cheap));
    expect(gate.redeemTicket(beforePasswordChange)).toBeUndefined();
  });

  test('leaves other paths to the caller', async () => {
    expect(await gate.route(req('GET'), '/api/sessions', body({}))).toBeUndefined();
  });

  test('lists devices and signs another one out; both are audited with failed logins', async () => {
    const phone = cookieOf((await login(PASSWORD, '10.0.0.2'))!.cookie);
    const laptop = cookieOf((await login(PASSWORD))!.cookie);
    await login('wrong', '10.0.0.9');
    expect(await gate.route(req('GET'), '/api/devices', body({}))).toMatchObject({ status: 401 });
    const listed = (await gate.route(req('GET', { cookie: laptop }), '/api/devices', body({})))!.body as { current: string; devices: { id: string; lastIp: string }[] };
    expect(listed.devices).toHaveLength(2);
    const other = listed.devices.find((device) => device.id !== listed.current)!;
    expect(other.lastIp).toBe('10.0.0.2');
    const noHeader = req('DELETE', { cookie: laptop, [WRITE_HEADER]: '' });
    expect(await gate.route(noHeader, `/api/devices/${other.id}`, body({}))).toMatchObject({ status: 403 });
    expect(await gate.route(req('DELETE', { cookie: laptop }), `/api/devices/${other.id}`, body({}))).toMatchObject({ status: 200 });
    expect(await gate.route(req('DELETE', { cookie: laptop }), `/api/devices/${other.id}`, body({}))).toMatchObject({ status: 404 });
    expect(gate.device(req('GET', { cookie: phone }))).toBeUndefined();
    const audit = (await gate.route(req('GET', { cookie: laptop }), '/api/audit', body({})))!.body as { entries: { kind: string; ip: string }[] };
    expect(audit.entries.map((entry) => entry.kind)).toEqual(['device_revoked', 'login_failed', 'login', 'login']);
    expect(audit.entries[1]!.ip).toBe('10.0.0.9');
  });
});

describe('deviceName', () => {
  test.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox · macOS'],
    ['', '未知浏览器'],
  ])('%s → %s', (ua, name) => {
    expect(deviceName(ua)).toBe(name);
  });
});
