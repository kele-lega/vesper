import type { TerminalSize } from './session.js';

interface Viewer {
  wanted: TerminalSize | undefined;
  lastInput: number;
  attachOrder: number;
}

/**
 * Decides the pty size when several devices show one session: it follows the
 * device that typed most recently (the driver). Other devices keep their own
 * wished-for size on record and show the session at the driver's size.
 *
 * When the driver leaves, the next one is promoted but its size waits for its
 * first keystroke or resize: a device that drops off for a moment must not make
 * the session shrink to someone else's window and back.
 *
 * Every method returns the size to apply now, or undefined to leave it alone.
 */
export class SizeArbiter<Id> {
  private readonly viewers = new Map<Id, Viewer>();
  private driverId: Id | undefined;
  /** Whether the pty has the driver's size; false for a driver promoted by a detach. */
  private driverApplied = false;
  private attachCounter = 0;
  private inputCounter = 0;

  get driver(): Id | undefined {
    return this.driverId;
  }

  attach(id: Id, wanted: TerminalSize | undefined): TerminalSize | undefined {
    this.viewers.set(id, { wanted, lastInput: 0, attachOrder: ++this.attachCounter });
    if (this.driverId !== undefined) return undefined;
    this.driverId = id;
    this.driverApplied = true;
    return wanted;
  }

  resize(id: Id, wanted: TerminalSize): TerminalSize | undefined {
    const viewer = this.viewers.get(id);
    if (viewer === undefined) return undefined;
    viewer.wanted = wanted;
    if (this.driverId !== id) return undefined;
    this.driverApplied = true;
    return wanted;
  }

  input(id: Id): TerminalSize | undefined {
    const viewer = this.viewers.get(id);
    if (viewer === undefined) return undefined;
    viewer.lastInput = ++this.inputCounter;
    if (this.driverId === id && this.driverApplied) return undefined;
    this.driverId = id;
    this.driverApplied = true;
    return viewer.wanted;
  }

  /** The next driver is whoever typed last, else whoever attached last; see the class comment for its size. */
  detach(id: Id): void {
    if (!this.viewers.delete(id) || this.driverId !== id) return;
    let next: [Id, Viewer] | undefined;
    for (const entry of this.viewers) {
      const [, viewer] = entry;
      const best = next?.[1];
      if (!best || viewer.lastInput > best.lastInput || (viewer.lastInput === best.lastInput && viewer.attachOrder > best.attachOrder)) {
        next = entry;
      }
    }
    this.driverId = next?.[0];
    this.driverApplied = false;
  }
}
