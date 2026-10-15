import { inspect } from 'node:util';

type Level = 'info' | 'warn' | 'error';
type Sink = (line: string) => void;

let sink: Sink = (line) => console.error(line);

/** Where log lines go; the detached ptyd process points this at its log file. */
export function setLogSink(next: Sink): Sink {
  const previous = sink;
  sink = next;
  return previous;
}

function write(level: Level, message: string, details: unknown[]): void {
  const extra = details.map((detail) => (detail instanceof Error ? (detail.stack ?? detail.message) : inspect(detail)));
  sink([new Date().toISOString(), level, message, ...extra].join(' '));
}

export const log = {
  info: (message: string, ...details: unknown[]) => write('info', message, details),
  warn: (message: string, ...details: unknown[]) => write('warn', message, details),
  error: (message: string, ...details: unknown[]) => write('error', message, details),
};

/** A listener set whose failing listeners are logged without stopping the others. */
export class Listeners<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private readonly kind: string) {}

  get size(): number {
    return this.listeners.size;
  }

  add(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        log.error(`${this.kind} listener failed`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
