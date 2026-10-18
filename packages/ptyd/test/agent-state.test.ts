import { describe, expect, test } from 'vitest';
import { AgentTracker, type AgentAlert, type TrackerClock } from '../src/agent-state.js';

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let next = 0;
  const clock: TrackerClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (id) => (timers = timers.filter((timer) => timer.id !== id)),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = end;
  };
  return { clock, advance };
}

function setup() {
  const { clock, advance } = fakeClock();
  const changes: [string, AgentAlert | undefined][] = [];
  const tracker = new AgentTracker((state, alert) => changes.push([state, alert]), clock);
  return { tracker, advance, changes };
}

describe('AgentTracker', () => {
  test('working then waiting alerts once; approving goes back to working', () => {
    const { tracker, changes } = setup();
    tracker.signal('working');
    tracker.signal('waiting');
    tracker.signal('waiting');
    tracker.signal('working');
    expect(changes).toEqual([['working', undefined], ['waiting', 'waiting'], ['working', undefined]]);
  });

  test('done waits 250 ms and for output to be quiet for a second', () => {
    const { tracker, advance, changes } = setup();
    tracker.signal('working');
    tracker.output();
    tracker.signal('done');
    advance(250);
    expect(tracker.state).toBe('working'); // output 250 ms ago
    advance(749);
    expect(tracker.state).toBe('working');
    advance(1);
    expect(changes.at(-1)).toEqual(['done', 'done']);
  });

  test('a new turn starting before done settles cancels it', () => {
    const { tracker, advance, changes } = setup();
    tracker.signal('working');
    tracker.signal('done');
    tracker.signal('working');
    advance(5000);
    expect(changes).toEqual([['working', undefined]]);
  });

  test('endless output still ends the turn after five seconds', () => {
    const { tracker, advance } = setup();
    tracker.signal('working');
    tracker.signal('done');
    for (let i = 0; i < 60; i++) {
      tracker.output();
      advance(100);
    }
    expect(tracker.state).toBe('done');
  });

  test('a stray done while idle settles without an alert; typing after done returns to idle', () => {
    const { tracker, advance, changes } = setup();
    tracker.signal('done');
    advance(2000);
    expect(changes).toEqual([['done', undefined]]);
    tracker.signal('input');
    expect(tracker.state).toBe('idle');
  });

  test('without hooks, the title going back to ready ends a turn', () => {
    const { tracker, advance, changes } = setup();
    tracker.signal('idle');
    expect(changes).toEqual([]);
    tracker.signal('working');
    tracker.signal('idle');
    advance(2000);
    expect(changes.at(-1)).toEqual(['done', 'done']);
  });
});
