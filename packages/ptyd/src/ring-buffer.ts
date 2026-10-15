/**
 * Fixed-capacity buffer of a session's most recent output bytes, addressed by
 * absolute stream offset (seq), so a reconnecting client can be sent exactly
 * the bytes it missed.
 */
export class RingBuffer {
  private readonly buffer: Uint8Array;
  private total = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`invalid ring capacity ${capacity}`);
    this.buffer = new Uint8Array(capacity);
  }

  /** Offset of the oldest retained byte. */
  get start(): number {
    return Math.max(0, this.total - this.capacity);
  }

  /** Offset just past the newest byte: the total number of bytes ever appended. */
  get end(): number {
    return this.total;
  }

  append(data: Uint8Array): void {
    if (data.length === 0) return;
    const kept = data.length > this.capacity ? data.subarray(data.length - this.capacity) : data;
    this.copyIn(kept, (this.total + data.length - kept.length) % this.capacity);
    this.total += data.length;
  }

  /** A copy of the bytes from offset `from` (at most `max` of them), or undefined if no longer retained. */
  read(from: number, max = Number.POSITIVE_INFINITY): Uint8Array | undefined {
    if (!Number.isSafeInteger(from) || from < this.start || from > this.total) return undefined;
    const out = new Uint8Array(Math.max(0, Math.min(this.total - from, max)));
    const position = from % this.capacity;
    const first = Math.min(out.length, this.capacity - position);
    out.set(this.buffer.subarray(position, position + first), 0);
    if (first < out.length) out.set(this.buffer.subarray(0, out.length - first), first);
    return out;
  }

  private copyIn(data: Uint8Array, position: number): void {
    const first = Math.min(data.length, this.capacity - position);
    this.buffer.set(data.subarray(0, first), position);
    if (first < data.length) this.buffer.set(data.subarray(first), 0);
  }
}
