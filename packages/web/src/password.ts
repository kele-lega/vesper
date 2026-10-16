import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes, stored as `scrypt$N$r$p$<salt>$<hash>` (base64url).
 * Passwords are NFKC-normalized first, so the same text typed on another
 * keyboard or system still matches.
 */
export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** OWASP's scrypt setting (2^17, 8, 1): about 128 MiB and a quarter second here. */
export const DEFAULT_COST: ScryptCost = { N: 1 << 17, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MIN_LENGTH = 12;
const MAX_LENGTH = 1024;
/** Bounds on a stored cost, so an edited database cannot make a login use gigabytes. */
const MAX_LOG_N = 17;
const MIN_LOG_N = 10;
const MAX_R = 8;
const MAX_P = 4;
const STORED = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}]/u;

/** Why a new password is not acceptable, in words for the user; undefined when it is fine. */
export function passwordProblem(password: string): string | undefined {
  const length = [...password.normalize('NFKC')].length;
  if (CONTROL.test(password)) return '密码不能包含控制字符';
  if (length < MIN_LENGTH) return `密码至少要 ${MIN_LENGTH} 个字符`;
  if (length > MAX_LENGTH) return `密码最多 ${MAX_LENGTH} 个字符`;
  return undefined;
}

export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** False for a wrong password and for a stored value that is malformed or out of bounds. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match) return false;
  const cost = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!acceptableCost(cost)) return false;
  const expected = Buffer.from(match[5]!, 'base64url');
  const key = await derive(password, Buffer.from(match[4]!, 'base64url'), cost);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function acceptableCost({ N, r, p }: ScryptCost): boolean {
  const logN = Math.log2(N);
  return Number.isInteger(logN) && logN >= MIN_LOG_N && logN <= MAX_LOG_N && r >= 1 && r <= MAX_R && p >= 1 && p <= MAX_P;
}

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; twice that leaves room for its other buffers.
  const maxmem = 2 * 128 * cost.N * cost.r;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...cost, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}
