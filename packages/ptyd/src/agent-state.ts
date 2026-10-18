/**
 * Follows what an agent CLI is doing (design.md §7.2) from its hooks, its window title and
 * its output, and says when that deserves an alert: on becoming "waiting" (it needs the user)
 * or "done" (it finished a turn). "done" waits a moment and for output to go quiet, so the
 * last lines of a turn cannot pass for the next one starting.
 */
import type { AgentState } from '@vesper/protocol';

/** working/waiting/done: what a hook or OSC 9 said. idle: the title shows the agent ready. input: the user typed. */
export type AgentSignal = 'working' | 'waiting' | 'done' | 'idle' | 'input';
export type AgentAlert = 'waiting' | 'done';

export interface TrackerClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const DONE_DELAY_MS = 250;
const DONE_QUIET_MS = 1000;
/** A turn that ends among output that never stops (a clock in the status line) is done after this anyway. */
const DONE_MAX_WAIT_MS = 5000;

const systemClock: TrackerClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms).unref(),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export class AgentTracker {
  private current: AgentState = 'idle';
  private lastOutputAt = 0;
  private pending: { since: number; from: AgentState; timer: unknown } | undefined;

  constructor(
    private readonly onChange: (state: AgentState, alert: AgentAlert | undefined) => void,
    private readonly clock: TrackerClock = systemClock,
  ) {}

  get state(): AgentState {
    return this.current;
  }

  output(): void {
    this.lastOutputAt = this.clock.now();
  }

  signal(signal: AgentSignal): void {
    switch (signal) {
      case 'working':
        this.cancelDone();
        return this.set('working', undefined);
      case 'waiting':
        this.cancelDone();
        return this.set('waiting', this.current === 'waiting' ? undefined : 'waiting');
      case 'done':
        return this.startDone();
      case 'idle':
        // Without a hook (a custom command), the title going back to ready is how a turn ends.
        if (this.current === 'working') this.startDone();
        return;
      case 'input':
        // Typing after a finished turn: it has been seen, and the next turn starts from idle.
        if (this.current === 'done') this.set('idle', undefined);
    }
  }

  dispose(): void {
    this.cancelDone();
  }

  private startDone(): void {
    if (this.current === 'done' || this.pending) return;
    const since = this.clock.now();
    this.pending = { since, from: this.current, timer: this.clock.setTimeout(() => this.checkDone(), DONE_DELAY_MS) };
  }

  private checkDone(): void {
    const pending = this.pending;
    if (!pending) return;
    const now = this.clock.now();
    const quietAt = this.lastOutputAt + DONE_QUIET_MS;
    if (now < quietAt && now - pending.since < DONE_MAX_WAIT_MS) {
      pending.timer = this.clock.setTimeout(() => this.checkDone(), Math.min(quietAt, pending.since + DONE_MAX_WAIT_MS) - now);
      return;
    }
    this.pending = undefined;
    // Only a turn seen running alerts; a stray "done" while idle just settles the state.
    this.set('done', pending.from === 'working' || pending.from === 'waiting' ? 'done' : undefined);
  }

  private cancelDone(): void {
    if (!this.pending) return;
    this.clock.clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  private set(state: AgentState, alert: AgentAlert | undefined): void {
    if (state === this.current && !alert) return;
    this.current = state;
    this.onChange(state, alert);
  }
}
