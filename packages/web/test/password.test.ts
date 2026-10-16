import { describe, expect, test } from 'vitest';
import { hashPassword, passwordProblem, verifyPassword } from '../src/password.js';

/** Cheap parameters keep the tests fast; production uses DEFAULT_COST. */
const cheap = { N: 1 << 10, r: 8, p: 1 };

describe('password hashing', () => {
  test('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery', cheap);
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  test('salts every hash', async () => {
    expect(await hashPassword('same password', cheap)).not.toBe(await hashPassword('same password', cheap));
  });

  test('treats composed and decomposed characters as the same password', async () => {
    const composed = 'caf\u{e9} au lait';
    const decomposed = 'cafe\u{301} au lait';
    expect(composed).not.toBe(decomposed);
    expect(await verifyPassword(decomposed, await hashPassword(composed, cheap))).toBe(true);
  });

  test.each(['', 'bcrypt$10$abc', 'scrypt$1024$8$1$c2FsdA', 'scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA'])(
    'rejects a malformed stored hash %j',
    async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false);
    },
  );

  test.each([
    ['N too small', 1 << 4, 8, 1],
    ['r too large', 1024, 64, 1],
    ['p too large', 1024, 8, 16],
  ])('refuses a correct hash made with a cost out of bounds (%s)', async (_, N, r, p) => {
    const stored = await hashPassword('the password!', { N, r, p });
    expect(await verifyPassword('the password!', stored)).toBe(false);
  });

  test.each([
    ['N not a power of two', 1000],
    ['N too large', 1 << 22],
  ])('returns false for a stored cost scrypt cannot or should not run (%s)', async (_, N) => {
    const [, , , , salt, key] = (await hashPassword('the password!', cheap)).split('$');
    expect(await verifyPassword('the password!', `scrypt$${N}$8$1$${salt}$${key}`)).toBe(false);
  });
});

describe('passwordProblem', () => {
  test('wants at least 12 characters, counting Chinese characters as one each', () => {
    expect(passwordProblem('short')).toMatch(/12/);
    expect(passwordProblem('twelve chars')).toBeUndefined();
    expect(passwordProblem('这是一个足够长的中文密码短语')).toBeUndefined();
    expect(passwordProblem('中文密码太短')).toMatch(/12/);
  });

  test('refuses very long passwords and control characters', () => {
    expect(passwordProblem('x'.repeat(1025))).toMatch(/1024/);
    expect(passwordProblem('twelve chars\u{0}')).toBeDefined();
  });
});
