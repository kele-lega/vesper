import { describe, expect, test } from 'vitest';
import { LoginLimiter } from '../src/login-limiter.js';

const MINUTE = 60_000;

function limiter(overrides: Partial<ConstructorParameters<typeof LoginLimiter>[0]> = {}) {
  let now = 0;
  const instance = new LoginLimiter({ perIpPerMinute: 5, lockAfterFailures: 10, lockMs: 15 * MINUTE, globalPerMinute: 30, globalBurst: 3, maxWaitMs: 10_000, ...overrides }, () => now);
  return { limiter: instance, advance: (ms: number) => (now += ms) };
}

describe('LoginLimiter', () => {
  test('allows five attempts per address per minute', () => {
    const { limiter: limit, advance } = limiter({ globalBurst: 100 });
    for (let i = 0; i < 5; i++) expect(limit.admit('a')).toEqual({ ok: true, waitMs: 0 });
    expect(limit.admit('a')).toEqual({ ok: false, retryAfterMs: MINUTE });
    expect(limit.admit('b').ok).toBe(true);
    advance(MINUTE / 2);
    expect(limit.admit('a')).toEqual({ ok: false, retryAfterMs: MINUTE / 2 });
    advance(MINUTE / 2);
    expect(limit.admit('a').ok).toBe(true);
  });

  test('ten failures in a row lock the address for fifteen minutes; a success clears the count', () => {
    const { limiter: limit, advance } = limiter({ globalBurst: 100 });
    for (let i = 0; i < 9; i++) {
      if (i % 5 === 0) advance(MINUTE);
      expect(limit.admit('a').ok).toBe(true);
      limit.failed('a');
    }
    limit.succeeded('a');
    advance(MINUTE);
    for (let i = 0; i < 10; i++) {
      if (i % 5 === 0) advance(MINUTE);
      limit.admit('a');
      limit.failed('a');
    }
    advance(MINUTE);
    expect(limit.admit('a')).toEqual({ ok: false, retryAfterMs: 14 * MINUTE });
    expect(limit.admit('b').ok).toBe(true);
    advance(14 * MINUTE);
    expect(limit.admit('a').ok).toBe(true);
  });

  test('the global cap delays attempts rather than refusing them, up to a bounded wait', () => {
    const { limiter: limit } = limiter({ globalPerMinute: 30, globalBurst: 3, maxWaitMs: 4000 });
    const results = ['a', 'b', 'c', 'd', 'e', 'f'].map((ip) => limit.admit(ip));
    expect(results).toEqual([
      { ok: true, waitMs: 0 },
      { ok: true, waitMs: 0 },
      { ok: true, waitMs: 0 },
      { ok: true, waitMs: 2000 },
      { ok: true, waitMs: 4000 },
      { ok: false, retryAfterMs: 2000 },
    ]);
  });

  test('an attempt refused by the global cap does not count against its address', () => {
    const { limiter: limit, advance } = limiter({ globalPerMinute: 60, globalBurst: 1, maxWaitMs: 0 });
    expect(limit.admit('a').ok).toBe(true);
    for (let i = 0; i < 10; i++) expect(limit.admit('a').ok).toBe(false);
    advance(1000);
    expect(limit.admit('a').ok).toBe(true);
  });

  test('forgets idle addresses', () => {
    const { limiter: limit, advance } = limiter();
    limit.admit('a');
    limit.failed('a');
    advance(16 * MINUTE);
    limit.admit('b');
    expect(limit.trackedAddresses).toBe(1);
  });
});
