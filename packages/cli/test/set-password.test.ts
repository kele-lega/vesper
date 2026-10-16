import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, openWebDatabase, verifyPassword } from '@vesper/web/auth';
import { afterEach, describe, expect, test } from 'vitest';
import { setPassword } from '../src/set-password.js';

const cheap = { N: 1 << 10, r: 8, p: 1 };
const answers = (...values: string[]) => {
  const queue = [...values];
  return async () => queue.shift() ?? '';
};

describe('setPassword', () => {
  const dirs: string[] = [];
  const dbPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vesper-cli-'));
    dirs.push(dir);
    return join(dir, 'web', 'vesper.db');
  };
  const storedHash = (path: string) => {
    const db = openWebDatabase(path);
    try {
      return new AuthStore(db).passwordHash();
    } finally {
      db.close();
    }
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('stores a hash of the password typed twice, and signs devices out', async () => {
    const path = dbPath();
    const db = openWebDatabase(path);
    const { token } = new AuthStore(db).createDevice('old', '127.0.0.1');
    db.close();
    const result = await setPassword(path, answers('a long passphrase', 'a long passphrase'), cheap);
    expect(result).toEqual({ ok: true, message: expect.stringContaining('已设置') });
    expect(await verifyPassword('a long passphrase', storedHash(path)!)).toBe(true);
    const reopened = openWebDatabase(path);
    expect(new AuthStore(reopened).authenticate(token, '127.0.0.1')).toBeUndefined();
    reopened.close();
  });

  test('refuses a weak password or a mismatch, and changes nothing', async () => {
    const path = dbPath();
    expect(await setPassword(path, answers('short'), cheap)).toEqual({ ok: false, message: expect.stringContaining('12') });
    expect(await setPassword(path, answers('a long passphrase', 'a long passphrasf'), cheap)).toEqual({ ok: false, message: '两次输入的密码不一致' });
    expect(storedHash(path)).toBeUndefined();
  });

  test('never repeats the password in its messages', async () => {
    const path = dbPath();
    const secret = 'secret-passphrase-1';
    for (const result of [await setPassword(path, answers(secret, `${secret}x`), cheap), await setPassword(path, answers(secret, secret), cheap)]) {
      expect(result.message).not.toContain(secret);
    }
  });
});
