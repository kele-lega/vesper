import { describe, expect, test } from 'vitest';
import { checkProof, newNonce, proof } from '../src/handshake.js';

describe('pipe handshake proofs', () => {
  test('a proof checks out only for the same token, side and nonce', () => {
    const nonce = newNonce();
    const host = proof('token-a', 'host', nonce);
    expect(checkProof('token-a', 'host', nonce, host)).toBe(true);
    expect(checkProof('token-b', 'host', nonce, host)).toBe(false);
    expect(checkProof('token-a', 'client', nonce, host)).toBe(false);
    expect(checkProof('token-a', 'host', newNonce(), host)).toBe(false);
  });

  test('rejects proofs of the wrong length without throwing', () => {
    expect(checkProof('token-a', 'client', 'n', '')).toBe(false);
    expect(checkProof('token-a', 'client', 'n', 'x'.repeat(200))).toBe(false);
  });

  test('nonces are fresh base64url strings', () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newNonce()).not.toBe(a);
  });
});
