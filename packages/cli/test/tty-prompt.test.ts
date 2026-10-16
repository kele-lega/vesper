import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { readHidden } from '../src/tty-prompt.js';

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const written: string[] = [];
  const output = { write: (text: string) => written.push(text) };
  const read = (prompt: string) => readHidden(prompt, input as unknown as typeof process.stdin, output as unknown as typeof process.stdout);
  return { input, written, read };
}

describe('readHidden', () => {
  test('returns what was typed without echoing it, handling backspace over a Chinese character', async () => {
    const { input, written, read } = terminal();
    const line = read('密码：');
    input.write('pass中');
    input.write('\u{7f}wörd\r');
    expect(await line).toBe('passwörd');
    expect(written.join('')).toBe('密码：\n');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  test('Ctrl+C cancels and restores the terminal', async () => {
    const { input, read } = terminal();
    const line = read('密码：');
    input.write('abc\u{3}');
    await expect(line).rejects.toThrow('已取消');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  test('refuses to read from something that is not a terminal', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    await expect(readHidden('x', input as unknown as typeof process.stdin)).rejects.toThrow('终端');
  });
});
