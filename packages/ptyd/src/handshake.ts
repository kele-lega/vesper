import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Mutual authentication on the ptyd pipe. The pipe name is predictable, so a
 * process of another account could create it first; the client must not trust
 * whoever answers. Each side proves it holds the run-file token by answering the
 * other side's fresh nonce, and the token itself never crosses the pipe. The side
 * label keeps one side's proof from being replayed as the other's.
 */

const NONCE_BYTES = 16;

export type ProofSide = 'host' | 'client';

export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url');
}

export function proof(token: string, side: ProofSide, nonce: string): string {
  return createHmac('sha256', token).update(`vesper-${side}:${nonce}`).digest('base64url');
}

export function checkProof(token: string, side: ProofSide, nonce: string, given: string): boolean {
  const expected = Buffer.from(proof(token, side, nonce), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
