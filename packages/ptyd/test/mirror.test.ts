import { afterEach, describe, expect, test } from 'vitest';
import { ScreenMirror } from '../src/mirror.js';

describe('ScreenMirror', () => {
  const mirrors: ScreenMirror[] = [];
  const create = (cols = 40, rows = 5): ScreenMirror => {
    const mirror = new ScreenMirror({ cols, rows, scrollback: 50 });
    mirrors.push(mirror);
    return mirror;
  };

  afterEach(() => {
    for (const mirror of mirrors.splice(0)) mirror.dispose();
  });

  test('answers DA1 through its reply listeners', async () => {
    const mirror = create();
    const replies: string[] = [];
    mirror.onReply((reply) => replies.push(reply));
    mirror.write('\x1b[c');
    await mirror.flush();
    expect(replies.join('')).toMatch(/^\x1b\[\?\d+(;\d+)*c$/);
  });

  test('answers colour queries from the Campbell theme', async () => {
    const mirror = create();
    const replies: string[] = [];
    mirror.onReply((reply) => replies.push(reply));
    mirror.write('\x1b]11;?\x07');
    await mirror.flush();
    expect(replies).toEqual(['\x1b]11;rgb:0c0c/0c0c/0c0c\x07']);
  });

  test('drops replies while nobody listens', async () => {
    const mirror = create();
    mirror.write('\x1b[c');
    await mirror.flush();
    const replies: string[] = [];
    mirror.onReply((reply) => replies.push(reply));
    await mirror.flush();
    expect(replies).toEqual([]);
  });

  test('reports directory reports with their nonce, including paths that hold semicolons', async () => {
    const mirror = create();
    const reports: { nonce: string; path: string }[] = [];
    mirror.onCwd((report) => reports.push(report));
    mirror.write('\x1b]7690;cwd;abc;C:\\Users\\me\x07\x1b]7690;cwd;x_-1;D:\\代码;项目\x1b\\');
    mirror.write('\x1b]7690;other;thing\x07\x1b]7690;cwd;;C:\\nononce\x07\x1b]9;9;C:\\ignored\x07');
    await mirror.flush();
    expect(reports).toEqual([
      { nonce: 'abc', path: 'C:\\Users\\me' },
      { nonce: 'x_-1', path: 'D:\\代码;项目' },
    ]);
  });

  test('reports title changes', async () => {
    const mirror = create();
    const titles: string[] = [];
    mirror.onTitle((title) => titles.push(title));
    mirror.write('\x1b]0;Windows PowerShell\x07');
    await mirror.flush();
    expect(titles).toEqual(['Windows PowerShell']);
  });

  test('reports OSC 9 and OSC 777 notifications, not ConEmu subcommands', async () => {
    const mirror = create();
    const notices: { title: string; body: string }[] = [];
    mirror.onNotice((notice) => notices.push(notice));
    mirror.write('\x1b]9;Codex needs approval\x07\x1b]9;4;1;50\x07\x1b]9;9;C:\\work\x07');
    mirror.write('\x1b]777;notify;Build;failed; see log\x1b\\\x1b]777;precmd\x07');
    await mirror.flush();
    expect(notices).toEqual([
      { title: '', body: 'Codex needs approval' },
      { title: 'Build', body: 'failed; see log' },
    ]);
  });

  test('tracks the alternate screen', async () => {
    const mirror = create();
    mirror.write('\x1b[?1049h');
    await mirror.flush();
    expect(mirror.alternateScreen).toBe(true);
    mirror.write('\x1b[?1049l');
    await mirror.flush();
    expect(mirror.alternateScreen).toBe(false);
  });

  test('finds the last used row and the visible text', async () => {
    const mirror = create();
    expect(mirror.lastUsedRow()).toBe(-1);
    mirror.write('one\r\ntwo\r\n');
    await mirror.flush();
    expect(mirror.lastUsedRow()).toBe(1);
    expect(mirror.screenText()).toBe('one\ntwo');
  });

  test('serializes into something another mirror reproduces', async () => {
    const source = create();
    source.write('\x1b[31mred\x1b[0m plain\r\n中文');
    await source.flush();
    const copy = create();
    copy.write(source.serialize());
    await copy.flush();
    expect(copy.screenText()).toBe(source.screenText());
  });

  test('accepts raw bytes and resizes', async () => {
    const mirror = create();
    mirror.write(Buffer.from('bytes', 'utf8'));
    mirror.resize(20, 3);
    await mirror.flush();
    expect([mirror.cols, mirror.rows]).toEqual([20, 3]);
    expect(mirror.screenText()).toBe('bytes');
  });
});
