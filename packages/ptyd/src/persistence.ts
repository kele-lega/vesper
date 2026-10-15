import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isInteger, isRecord } from '@vesper/protocol';
import { log } from './log.js';

/** A serialized screen at output offset seq of incarnation inc. */
export interface Checkpoint {
  inc: number;
  seq: number;
  cols: number;
  rows: number;
  data: string;
  savedAt: number;
}

/** Logged output written while the pty had this size. */
export interface TailPart {
  cols: number;
  rows: number;
  data: Uint8Array;
}

export interface Tail {
  inc: number;
  from: number;
  bytes: number;
  parts: TailPart[];
}

interface Segment {
  inc: number;
  from: number;
  cols: number;
  rows: number;
  written: number;
}

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_FILE = 'checkpoint.json';
const SEGMENT_PATTERN = /^out-(\d+)-(\d+)-(\d+)x(\d+)\.log$/;
const MAX_DIMENSION = 10_000;

/**
 * A session's files: the latest checkpoint plus the raw output logged since,
 * split into segments named out-<inc>-<first seq>-<cols>x<rows>.log. A resize
 * starts a new segment, so replay can resize at the same offset the pty did.
 * Restoring replays the checkpoint and then the log from the checkpoint's seq.
 */
export class SessionFiles {
  /** The segment being written; queued bytes continue it at from + written. */
  private segment: Segment | undefined;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  /** Queues output, produced while the pty had `size`, for the log; call flush() to write it. */
  append(inc: number, seq: number, data: Uint8Array, size: { cols: number; rows: number }): void {
    if (data.length === 0) return;
    const segment = this.segment;
    const continues =
      segment !== undefined &&
      segment.inc === inc &&
      segment.cols === size.cols &&
      segment.rows === size.rows &&
      seq === segment.from + segment.written + this.pendingBytes;
    if (!continues) {
      this.flush();
      this.segment = { inc, from: seq, cols: size.cols, rows: size.rows, written: 0 };
    }
    this.pending.push(data);
    this.pendingBytes += data.length;
  }

  flush(): void {
    const segment = this.segment;
    if (this.pendingBytes === 0 || segment === undefined) return;
    const data = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      // The first write truncates, so a stale file of the same name cannot shift the offsets.
      appendFileSync(this.segmentPath(segment), data, { flag: segment.written === 0 ? 'w' : 'a' });
      segment.written += data.length;
    } catch (error) {
      // A segment with a hole would replay the wrong bytes; the next append starts a new one.
      log.warn(`could not write the output log in ${this.dir}`, error);
      this.segment = undefined;
    }
  }

  /** Atomically replaces the checkpoint, then starts a new segment and drops the ones it covers. */
  writeCheckpoint(checkpoint: Checkpoint): boolean {
    this.flush();
    const path = join(this.dir, CHECKPOINT_FILE);
    const temp = `${path}.tmp`;
    try {
      const fd = openSync(temp, 'w');
      try {
        writeSync(fd, JSON.stringify({ v: CHECKPOINT_VERSION, ...checkpoint }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
    } catch (error) {
      log.warn(`could not write the checkpoint in ${this.dir}`, error);
      return false;
    }
    this.segment = undefined;
    this.prune(checkpoint);
    return true;
  }

  readCheckpoint(): Checkpoint | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir, CHECKPOINT_FILE), 'utf8');
    } catch {
      return undefined;
    }
    try {
      return parseCheckpoint(JSON.parse(raw));
    } catch (error) {
      log.warn(`ignoring the unreadable checkpoint in ${this.dir}`, error);
      return undefined;
    }
  }

  /** The newest incarnation that has logged output. */
  latestLoggedInc(): number | undefined {
    const incs = this.segments().map((segment) => segment.inc);
    return incs.length === 0 ? undefined : Math.max(...incs);
  }

  /**
   * Logged output of incarnation inc from offset `from` (or from its oldest kept
   * byte), up to maxBytes, stopping at any gap.
   */
  readTail(inc: number, from: number | undefined, maxBytes: number): Tail {
    const segments = this.segments().filter((segment) => segment.inc === inc).sort((a, b) => a.from - b.from);
    let next = from ?? segments[0]?.from ?? 0;
    const start = next;
    const parts: TailPart[] = [];
    let total = 0;
    for (const segment of segments) {
      let data: Buffer;
      try {
        data = readFileSync(join(this.dir, segment.name));
      } catch (error) {
        log.warn(`skipping unreadable log segment ${segment.name}`, error);
        continue; // treated as missing: the gap check below stops replay there
      }
      const end = segment.from + data.length;
      if (end <= next) continue;
      if (segment.from > next) break; // a hole: replaying past it would garble the screen
      const part = data.subarray(next - segment.from, next - segment.from + (maxBytes - total));
      parts.push({ cols: segment.cols, rows: segment.rows, data: part });
      total += part.length;
      next += part.length;
      if (total >= maxBytes) break;
    }
    return { inc, from: start, bytes: total, parts };
  }

  /** Discards what is queued and deletes every file of the session, without blocking the host. */
  remove(): Promise<void> {
    this.pending = [];
    this.pendingBytes = 0;
    this.segment = undefined;
    return rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  private segmentPath(segment: Omit<Segment, 'written'>): string {
    return join(this.dir, `out-${segment.inc}-${segment.from}-${segment.cols}x${segment.rows}.log`);
  }

  private segments(): (Omit<Segment, 'written'> & { name: string })[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      const match = SEGMENT_PATTERN.exec(name);
      if (!match) return [];
      const [, inc, from, cols, rows] = match.map(Number) as [number, number, number, number, number];
      return [{ name, inc, from, cols, rows }];
    });
  }

  /** Drops segments of older incarnations and those that end at or before the checkpoint. */
  private prune(checkpoint: Checkpoint): void {
    for (const segment of this.segments()) {
      const path = join(this.dir, segment.name);
      try {
        const end = segment.from + statSync(path).size;
        if (segment.inc < checkpoint.inc || (segment.inc === checkpoint.inc && end <= checkpoint.seq)) unlinkSync(path);
      } catch (error) {
        log.warn(`could not prune ${path}`, error);
      }
    }
  }
}

function parseCheckpoint(value: unknown): Checkpoint {
  if (!isRecord(value) || value.v !== CHECKPOINT_VERSION) throw new Error('unknown checkpoint version');
  const { inc, seq, cols, rows, data, savedAt } = value;
  if (
    !isInteger(inc, 0, 0xffff_ffff) ||
    !isInteger(seq, 0, Number.MAX_SAFE_INTEGER) ||
    !isInteger(cols, 1, MAX_DIMENSION) ||
    !isInteger(rows, 1, MAX_DIMENSION) ||
    typeof data !== 'string' ||
    !isInteger(savedAt, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('malformed checkpoint');
  }
  return { inc, seq, cols, rows, data, savedAt };
}
