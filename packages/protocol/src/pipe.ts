/**
 * Length-prefixed messages on the named pipe between vesper-web and vesper-ptyd.
 *
 * Each message is a big-endian u32 byte length followed by the payload. The
 * first message in each direction is JSON (hello and its reply). Control
 * channels stay JSON; attach channels switch to binary frames (see frames.ts).
 */

export const MAX_PIPE_MESSAGE = 32 << 20;
const HEADER_BYTES = 4;

export class PipeError extends Error {
  override name = 'PipeError';
}

export function encodePipeMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** Incremental decoder: copies each payload byte once, whatever the chunking. */
export class PipeReader {
  private readonly header = new Uint8Array(HEADER_BYTES);
  private headerFill = 0;
  private body: Uint8Array | undefined;
  private bodyFill = 0;

  constructor(
    private readonly onMessage: (payload: Uint8Array) => void,
    /** Largest accepted message; may change between messages (a server raises it after hello). */
    public maxMessage = MAX_PIPE_MESSAGE,
  ) {}

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.body === undefined) {
        offset = this.readHeader(chunk, offset);
        // Header still incomplete (chunk used up) or an empty message was just delivered.
        if (this.body === undefined) continue;
      }
      const take = Math.min(this.body.length - this.bodyFill, chunk.length - offset);
      this.body.set(chunk.subarray(offset, offset + take), this.bodyFill);
      this.bodyFill += take;
      offset += take;
      this.deliverIfComplete();
    }
  }

  private readHeader(chunk: Uint8Array, offset: number): number {
    const take = Math.min(HEADER_BYTES - this.headerFill, chunk.length - offset);
    this.header.set(chunk.subarray(offset, offset + take), this.headerFill);
    this.headerFill += take;
    if (this.headerFill < HEADER_BYTES) return offset + take;
    const length = new DataView(this.header.buffer).getUint32(0);
    if (length > this.maxMessage) throw new PipeError(`pipe message of ${length} bytes exceeds ${this.maxMessage}`);
    this.headerFill = 0;
    this.body = new Uint8Array(length);
    this.bodyFill = 0;
    this.deliverIfComplete();
    return offset + take;
  }

  private deliverIfComplete(): void {
    if (this.body === undefined || this.bodyFill < this.body.length) return;
    const message = this.body;
    this.body = undefined;
    this.onMessage(message);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(utf8.decode(payload));
  } catch (error) {
    throw new PipeError(`invalid JSON message: ${(error as Error).message}`);
  }
}
