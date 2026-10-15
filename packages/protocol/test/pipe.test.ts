import { describe, expect, test } from 'vitest';
import { decodeJson, encodeJson, encodePipeMessage, PipeError, PipeReader } from '../src/pipe.js';

function collect(max?: number): { reader: PipeReader; messages: Uint8Array[] } {
  const messages: Uint8Array[] = [];
  return { reader: new PipeReader((message) => messages.push(message), max), messages };
}

describe('pipe message framing', () => {
  test('prefixes the payload with a big-endian u32 length', () => {
    expect(Array.from(encodePipeMessage(Uint8Array.of(7, 8, 9)))).toEqual([0, 0, 0, 3, 7, 8, 9]);
  });

  test('reassembles a message delivered one byte at a time', () => {
    const { reader, messages } = collect();
    for (const byte of encodePipeMessage(Uint8Array.of(1, 2, 3, 4, 5))) reader.push(Uint8Array.of(byte));
    expect(messages.map((m) => Array.from(m))).toEqual([[1, 2, 3, 4, 5]]);
  });

  test('splits several messages arriving in one chunk', () => {
    const { reader, messages } = collect();
    const chunk = Buffer.concat([encodePipeMessage(Uint8Array.of(1)), encodePipeMessage(Uint8Array.of()), encodePipeMessage(Uint8Array.of(2, 3))]);
    reader.push(chunk);
    expect(messages.map((m) => Array.from(m))).toEqual([[1], [], [2, 3]]);
  });

  test('reassembles a large message split into uneven chunks', () => {
    const { reader, messages } = collect();
    const payload = Uint8Array.from({ length: 1 << 20 }, (_, i) => i % 251);
    const wire = encodePipeMessage(payload);
    for (let offset = 0; offset < wire.length; offset += 7001) reader.push(wire.subarray(offset, offset + 7001));
    expect(messages).toHaveLength(1);
    expect(Buffer.compare(messages[0]!, payload)).toBe(0);
  });

  test('rejects a length above the limit before buffering the body', () => {
    const { reader } = collect(16);
    expect(() => reader.push(Uint8Array.of(0, 0, 0, 17))).toThrow(PipeError);
  });
});

describe('JSON pipe messages', () => {
  test('round-trips values with non-ASCII text', () => {
    const value = { op: 'create', cwd: 'D:\\代码\\项目', n: 3 };
    expect(decodeJson(encodeJson(value))).toEqual(value);
  });

  test.each([
    ['invalid JSON', new TextEncoder().encode('{"op":')],
    ['invalid UTF-8', Uint8Array.of(0x7b, 0xff, 0x7d)],
  ])('rejects %s', (_name, payload) => {
    expect(() => decodeJson(payload)).toThrow(PipeError);
  });
});
