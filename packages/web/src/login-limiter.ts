const MINUTE = 60_000;

export interface LoginLimits {
  /** Attempts one address may make in any minute. */
  perIpPerMinute: number;
  /** Failures in a row that lock an address, and for how long. */
  lockAfterFailures: number;
  lockMs: number;
  /** Attempts per minute across all addresses; past this they are slowed, not locked. */
  globalPerMinute: number;
  globalBurst: number;
  /** Longest an attempt is held back by the global cap before it is refused instead. */
  maxWaitMs: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  perIpPerMinute: 5,
  lockAfterFailures: 10,
  lockMs: 15 * MINUTE,
  globalPerMinute: 30,
  /** Each attempt hashes with scrypt (about 128 MiB), so few may run at once. */
  globalBurst: 3,
  maxWaitMs: 10_000,
};

export type Admission = { ok: true; waitMs: number } | { ok: false; retryAfterMs: number };

interface Address {
  /** Admitted attempts within the last minute, oldest first. */
  attempts: number[];
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

/**
 * Login throttling. Each address gets a few attempts a minute and is locked after
 * repeated failures. The global cap only delays attempts (a token bucket kept as
 * a theoretical arrival time), so attackers spread over many addresses slow the
 * owner's login down but cannot lock the owner out. Addresses are tracked only
 * once admitted, which the global cap bounds, so memory stays bounded too.
 */
export class LoginLimiter {
  private readonly addresses = new Map<string, Address>();
  private theoreticalArrival = 0;
  private sweptAt = 0;

  constructor(
    private readonly limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  get trackedAddresses(): number {
    return this.addresses.size;
  }

  /** Whether an attempt from `ip` may go ahead, after waiting waitMs. Only admitted attempts count. */
  admit(ip: string): Admission {
    const now = this.now();
    this.sweep(now);
    const address = this.addresses.get(ip);
    if (address && address.lockedUntil > now) return { ok: false, retryAfterMs: address.lockedUntil - now };
    const recent = (address?.attempts ?? []).filter((at) => at > now - MINUTE);
    if (recent.length >= this.limits.perIpPerMinute) return { ok: false, retryAfterMs: recent[0]! + MINUTE - now };
    const interval = MINUTE / this.limits.globalPerMinute;
    const arrival = Math.max(this.theoreticalArrival, now);
    const waitMs = Math.max(0, arrival - (this.limits.globalBurst - 1) * interval - now);
    if (waitMs > this.limits.maxWaitMs) return { ok: false, retryAfterMs: waitMs - this.limits.maxWaitMs };
    this.theoreticalArrival = arrival + interval;
    this.addresses.set(ip, { attempts: [...recent, now], failures: address?.failures ?? 0, lockedUntil: 0, lastSeen: now });
    return { ok: true, waitMs };
  }

  failed(ip: string): void {
    const address = this.addresses.get(ip);
    if (!address) return;
    const failures = address.failures + 1;
    const locked = failures >= this.limits.lockAfterFailures;
    this.addresses.set(ip, {
      ...address,
      failures: locked ? 0 : failures,
      lockedUntil: locked ? this.now() + this.limits.lockMs : address.lockedUntil,
    });
  }

  succeeded(ip: string): void {
    const address = this.addresses.get(ip);
    if (address) this.addresses.set(ip, { ...address, failures: 0 });
  }

  /** Forgets addresses idle for longer than a lock lasts; their failure count goes with them. */
  private sweep(now: number): void {
    if (now - this.sweptAt < MINUTE) return;
    this.sweptAt = now;
    for (const [ip, address] of this.addresses) {
      if (address.lockedUntil <= now && now - address.lastSeen > this.limits.lockMs) this.addresses.delete(ip);
    }
  }
}
