const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const CSI_INTRODUCER = 0x5b; // [
const OSC_INTRODUCER = 0x5d; // ]
const STRING_TERMINATOR_TAIL = 0x5c; // the \ of ESC \
const STRING_INTRODUCERS = new Set([0x50, 0x58, OSC_INTRODUCER, 0x5e, 0x5f]); // DCS SOS OSC PM APC
/** Longer unterminated strings (a huge OSC 52, say) are treated as complete. */
const MAX_SCAN = 64 * 1024;

/**
 * Length of an escape sequence at the end of `data` that is still open.
 *
 * A snapshot taken right after those bytes leaves the mirror's parser inside the
 * sequence, which a fresh terminal cannot reproduce. Cutting the snapshot before
 * the sequence and replaying it as ordinary output keeps both parsers in step.
 */
export function incompleteEscapeLength(data: Uint8Array): number {
  const floor = Math.max(0, data.length - MAX_SCAN);
  const last = data.lastIndexOf(ESC);
  if (last < floor) return 0;
  // A valid sequence never contains ESC, so only the last one can still be open,
  // unless it is the first half of the ST that closes an earlier string.
  if (data[last + 1] === STRING_TERMINATOR_TAIL) return 0;
  if (last === data.length - 1) {
    const opener = last > 0 ? data.lastIndexOf(ESC, last - 1) : -1;
    if (opener >= floor && STRING_INTRODUCERS.has(data[opener + 1] ?? 0) && !stringEnded(data, opener, last)) {
      return data.length - opener;
    }
    return 1;
  }
  return sequenceEnded(data, last) ? 0 : data.length - last;
}

function sequenceEnded(data: Uint8Array, start: number): boolean {
  const kind = data[start + 1] ?? 0;
  if (kind === CSI_INTRODUCER) return endsWithin(data, start + 2, 0x40);
  if (STRING_INTRODUCERS.has(kind)) return stringEnded(data, start, data.length);
  if (kind >= 0x20 && kind <= 0x2f) return endsWithin(data, start + 2, 0x30); // ESC ( B and friends
  return true; // two-byte escapes such as ESC 7 or ESC M
}

/** True once a final byte in [minFinal, 0x7e] or an aborting CAN/SUB appears. */
function endsWithin(data: Uint8Array, from: number, minFinal: number): boolean {
  for (let i = from; i < data.length; i++) {
    const byte = data[i] ?? 0;
    if ((byte >= minFinal && byte <= 0x7e) || byte === CAN || byte === SUB) return true;
  }
  return false;
}

/** Strings end with ST (handled by the caller), CAN or SUB; OSC also ends with BEL. */
function stringEnded(data: Uint8Array, start: number, to: number): boolean {
  const belEnds = data[start + 1] === OSC_INTRODUCER;
  for (let i = start + 2; i < to; i++) {
    const byte = data[i];
    if (byte === CAN || byte === SUB || (belEnds && byte === BEL)) return true;
  }
  return false;
}

interface RetainedOutput {
  readonly start: number;
  read(from: number, max?: number): Uint8Array | undefined;
}

/** Where a snapshot of the output up to `end` should claim to be: before any sequence still open there. */
export function snapshotCut(output: RetainedOutput, end: number): number {
  const from = Math.max(output.start, end - MAX_SCAN);
  const tail = output.read(from, end - from);
  return tail === undefined ? end : end - incompleteEscapeLength(tail);
}

/**
 * How many bytes at the start of `next` finish the open escape sequence `open`
 * (which starts with ESC, as found by incompleteEscapeLength): 0 when next starts
 * by aborting it, undefined when next does not settle it yet.
 */
export function openSequenceRemainder(open: Uint8Array, next: Uint8Array): number | undefined {
  if (open.length === 1) return afterLoneEsc(next);
  const kind = open[1] ?? 0;
  if (kind === CSI_INTRODUCER) return scanToFinal(next, 0, 0x40);
  if (STRING_INTRODUCERS.has(kind)) {
    if (open[open.length - 1] === ESC) {
      // The string's ESC is either the start of ST or aborts it and starts a new sequence.
      if (next[0] === undefined) return undefined;
      if (next[0] === STRING_TERMINATOR_TAIL) return 1;
      return afterLoneEsc(next);
    }
    return scanString(next, kind === OSC_INTRODUCER);
  }
  return scanToFinal(next, 0, 0x30); // ESC ( and friends
}

function afterLoneEsc(next: Uint8Array): number | undefined {
  const kind = next[0];
  if (kind === undefined) return undefined;
  if (kind === CSI_INTRODUCER) return plus(scanToFinal(next, 1, 0x40));
  if (STRING_INTRODUCERS.has(kind)) return plus(scanString(next.subarray(1), kind === OSC_INTRODUCER), 1);
  if (kind >= 0x20 && kind <= 0x2f) return plus(scanToFinal(next, 1, 0x30));
  return 1; // a two-byte escape such as ESC 7
}

function plus(length: number | undefined, offset: number = 0): number | undefined {
  return length === undefined ? undefined : length + offset;
}

/** Index just past the final byte (or an aborting CAN/SUB); the index of an aborting ESC. */
function scanToFinal(data: Uint8Array, from: number, minFinal: number): number | undefined {
  for (let i = from; i < data.length; i++) {
    const byte = data[i] ?? 0;
    if (byte === ESC) return i;
    if ((byte >= minFinal && byte <= 0x7e) || byte === CAN || byte === SUB) return i + 1;
  }
  return undefined;
}

function scanString(data: Uint8Array, belEnds: boolean): number | undefined {
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === CAN || byte === SUB || (belEnds && byte === BEL)) return i + 1;
    if (byte !== ESC) continue;
    if (data[i + 1] === undefined) return undefined;
    return data[i + 1] === STRING_TERMINATOR_TAIL ? i + 2 : i;
  }
  return undefined;
}
