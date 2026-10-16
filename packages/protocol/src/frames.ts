/**
 * Binary frames shared by the browser, the web server and the pty host.
 *
 * Every frame starts with one type byte. Integers are big-endian.
 *   input    0x01  data...                      browser -> host, raw UTF-8 keystrokes
 *   resize   0x02  cols u16, rows u16
 *   ack      0x03  seq u64                      output offset the browser has parsed
 *   ping     0x04  nonce u32
 *   pong     0x05  nonce u32
 *   output   0x81  seq u64, data...             seq = offset of data[0] in the session stream
 *   snapshot 0x82  inc u32, seq u64, cols u16, rows u16, data...
 *   exit     0x83  code i32
 *   size     0x84  cols u16, rows u16            the session's current pty size
 *   closed   0x85  reason u8                     host -> web only: why the attach channel ends
 *
 * inc is the session incarnation: it changes whenever the shell is restarted
 * (for example after a reboot), and seq restarts from 0 with it.
 */

/** restarted: the session's program started again; reattach for a fresh snapshot. */
export const CLOSE_REASONS = ['removed', 'shutdown', 'restarted'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export type Frame =
  | { type: 'input'; data: Uint8Array }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; seq: number }
  | { type: 'ping'; nonce: number }
  | { type: 'pong'; nonce: number }
  | { type: 'output'; seq: number; data: Uint8Array }
  | { type: 'snapshot'; inc: number; seq: number; cols: number; rows: number; data: Uint8Array }
  | { type: 'exit'; code: number }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'closed'; reason: CloseReason };

export class FrameError extends Error {
  override name = 'FrameError';
}

const TYPE_CODES = {
  input: 0x01,
  resize: 0x02,
  ack: 0x03,
  ping: 0x04,
  pong: 0x05,
  output: 0x81,
  snapshot: 0x82,
  exit: 0x83,
  size: 0x84,
  closed: 0x85,
} as const satisfies Record<Frame['type'], number>;

const MAX_TERMINAL_DIMENSION = 10_000;
const MAX_U32 = 0xffff_ffff;
const MIN_I32 = -0x8000_0000;
const MAX_I32 = 0x7fff_ffff;

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case 'input':
      return withPayload(TYPE_CODES.input, 0, frame.data, () => undefined);
    case 'resize':
    case 'size':
      return fixed(TYPE_CODES[frame.type], 4, (view) => writeSize(view, 1, frame.cols, frame.rows));
    case 'ack':
      return fixed(TYPE_CODES.ack, 8, (view) => writeSeq(view, 1, frame.seq));
    case 'ping':
    case 'pong':
      return fixed(TYPE_CODES[frame.type], 4, (view) => view.setUint32(1, checkNonce(frame.nonce)));
    case 'output':
      return withPayload(TYPE_CODES.output, 8, frame.data, (view) => writeSeq(view, 1, frame.seq));
    case 'snapshot':
      return withPayload(TYPE_CODES.snapshot, 16, frame.data, (view) => {
        view.setUint32(1, checkIncarnation(frame.inc));
        writeSeq(view, 5, frame.seq);
        writeSize(view, 13, frame.cols, frame.rows);
      });
    case 'exit':
      return fixed(TYPE_CODES.exit, 4, (view) => view.setInt32(1, checkExitCode(frame.code)));
    case 'closed':
      return fixed(TYPE_CODES.closed, 1, (view) => view.setUint8(1, checkCloseReason(frame.reason)));
  }
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length === 0) throw new FrameError('empty frame');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const code = buf[0];
  switch (code) {
    case TYPE_CODES.input:
      return { type: 'input', data: buf.subarray(1) };
    case TYPE_CODES.resize:
      expectLength(buf, 5, 'resize');
      return { type: 'resize', ...readSize(view, 1) };
    case TYPE_CODES.ack:
      expectLength(buf, 9, 'ack');
      return { type: 'ack', seq: readSeq(view, 1) };
    case TYPE_CODES.ping:
    case TYPE_CODES.pong:
      expectLength(buf, 5, code === TYPE_CODES.ping ? 'ping' : 'pong');
      return { type: code === TYPE_CODES.ping ? 'ping' : 'pong', nonce: view.getUint32(1) };
    case TYPE_CODES.output:
      expectMinLength(buf, 9, 'output');
      return { type: 'output', seq: readSeq(view, 1), data: buf.subarray(9) };
    case TYPE_CODES.snapshot:
      expectMinLength(buf, 17, 'snapshot');
      return {
        type: 'snapshot',
        inc: view.getUint32(1),
        seq: readSeq(view, 5),
        ...readSize(view, 13),
        data: buf.subarray(17),
      };
    case TYPE_CODES.exit:
      expectLength(buf, 5, 'exit');
      return { type: 'exit', code: view.getInt32(1) };
    case TYPE_CODES.size:
      expectLength(buf, 5, 'size');
      return { type: 'size', ...readSize(view, 1) };
    case TYPE_CODES.closed:
      expectLength(buf, 2, 'closed');
      return { type: 'closed', reason: readCloseReason(view.getUint8(1)) };
    default:
      throw new FrameError(`unknown frame type 0x${code?.toString(16)}`);
  }
}

function fixed(code: number, size: number, write: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(1 + size);
  out[0] = code;
  write(new DataView(out.buffer));
  return out;
}

function withPayload(code: number, header: number, data: Uint8Array, write: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(1 + header + data.length);
  out[0] = code;
  write(new DataView(out.buffer));
  out.set(data, 1 + header);
  return out;
}

function writeSeq(view: DataView, offset: number, seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new FrameError(`invalid sequence ${seq}`);
  view.setBigUint64(offset, BigInt(seq));
}

function readSeq(view: DataView, offset: number): number {
  const seq = view.getBigUint64(offset);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrameError(`sequence ${seq} exceeds MAX_SAFE_INTEGER`);
  return Number(seq);
}

function writeSize(view: DataView, offset: number, cols: number, rows: number): void {
  checkSize(cols, rows);
  view.setUint16(offset, cols);
  view.setUint16(offset + 2, rows);
}

function readSize(view: DataView, offset: number): { cols: number; rows: number } {
  const cols = view.getUint16(offset);
  const rows = view.getUint16(offset + 2);
  checkSize(cols, rows);
  return { cols, rows };
}

function checkSize(cols: number, rows: number): void {
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_TERMINAL_DIMENSION;
  if (!valid(cols) || !valid(rows)) throw new FrameError(`invalid terminal size ${cols}x${rows}`);
}

function checkNonce(nonce: number): number {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > MAX_U32) throw new FrameError(`invalid nonce ${nonce}`);
  return nonce;
}

function checkIncarnation(inc: number): number {
  if (!Number.isInteger(inc) || inc < 0 || inc > MAX_U32) throw new FrameError(`invalid incarnation ${inc}`);
  return inc;
}

function checkCloseReason(reason: CloseReason): number {
  const index = CLOSE_REASONS.indexOf(reason);
  if (index < 0) throw new FrameError(`invalid close reason ${String(reason)}`);
  return index;
}

function readCloseReason(code: number): CloseReason {
  const reason = CLOSE_REASONS[code];
  if (reason === undefined) throw new FrameError(`unknown close reason ${code}`);
  return reason;
}

function checkExitCode(code: number): number {
  if (!Number.isInteger(code) || code < MIN_I32 || code > MAX_I32) throw new FrameError(`invalid exit code ${code}`);
  return code;
}

function expectLength(buf: Uint8Array, length: number, name: string): void {
  expectMinLength(buf, length, name);
  if (buf.length !== length) throw new FrameError(`invalid ${name} frame length ${buf.length}`);
}

function expectMinLength(buf: Uint8Array, length: number, name: string): void {
  if (buf.length < length) throw new FrameError(`truncated ${name} frame`);
}
