/** The parts of an xterm.js Terminal (browser or headless) this queue drives. */
export interface WritableTerminal {
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  reset(): void;
}

type Step =
  | { kind: 'write'; data: string | Uint8Array; parsed?: () => void }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'replace'; cols: number; rows: number; data: string | Uint8Array; parsed?: () => void };

/**
 * xterm.js parses writes asynchronously but resizes and resets at once, so a
 * resize could apply to output still queued before it, and a reset would not
 * clear writes queued before it. This queue runs every step in arrival order:
 * a resize or a new screen waits until everything before it has been parsed.
 */
export class OrderedTerminal {
  private readonly steps: Step[] = [];
  private waiting = false;

  constructor(private readonly term: WritableTerminal) {}

  write(data: string | Uint8Array, parsed?: () => void): void {
    this.enqueue(parsed ? { kind: 'write', data, parsed } : { kind: 'write', data });
  }

  resize(cols: number, rows: number): void {
    this.enqueue({ kind: 'resize', cols, rows });
  }

  /** Replaces the screen (a snapshot); output after it is parsed on the new screen. */
  replace(cols: number, rows: number, data: string | Uint8Array, parsed?: () => void): void {
    this.enqueue(parsed ? { kind: 'replace', cols, rows, data, parsed } : { kind: 'replace', cols, rows, data });
  }

  private enqueue(step: Step): void {
    this.steps.push(step);
    this.drain();
  }

  private drain(): void {
    while (!this.waiting && this.steps.length > 0) {
      const step = this.steps.shift()!;
      if (step.kind === 'write') {
        this.term.write(step.data, step.parsed); // writes keep their order inside xterm.js
        continue;
      }
      // Wait for everything written so far, then act before anything later is written.
      this.waiting = true;
      this.term.write('', () => {
        if (step.kind === 'replace') this.term.reset();
        if (step.cols !== this.term.cols || step.rows !== this.term.rows) this.term.resize(step.cols, step.rows);
        if (step.kind === 'replace') this.term.write(step.data, step.parsed);
        this.waiting = false;
        this.drain();
      });
    }
  }
}
