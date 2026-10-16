import { tmpdir } from 'node:os';
import xtermHeadless from '@xterm/headless';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ScreenMirror } from '../src/mirror.js';
import { PtySession, type SessionOptions } from '../src/session.js';
import { shellLaunchSpec, type LaunchSpec, type ShellKind } from '../src/shells.js';

const paths = {
  systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
  gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe',
};
const cmdExe = `${paths.systemRoot}\\System32\\cmd.exe`;
const SLOW = 20_000;

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * cmd's screen after a run of `echo` commands: from the first command still shown, each one
 * above its output and a blank line, none missing, then the prompt. With rows out of line
 * with ConPTY, new text lands on old lines and replaces or garbles them.
 */
function expectEchoes(screen: string, prompt: string, words: readonly string[]): void {
  const lines = screen.split('\n');
  const shown = lines.slice(lines.findIndex((line) => /^.*>echo [a-z]+$/.test(line)));
  const count = Math.max(1, Math.floor((shown.length - 1) / 3));
  const expected = words.slice(-count).flatMap((word) => [`${prompt}echo ${word}`, word, '']);
  expect(shown).toEqual([...expected, prompt]);
}

describe.runIf(process.platform === 'win32')('PtySession on ConPTY', () => {
  const sessions: PtySession[] = [];
  const start = (launch: LaunchSpec, overrides: Partial<SessionOptions> = {}): PtySession => {
    const session = PtySession.spawn({ launch, cwd: tmpdir(), cols: 100, rows: 30, ...overrides });
    sessions.push(session);
    return session;
  };
  const startShell = (kind: ShellKind) => start(shellLaunchSpec(kind, paths, { cwdNonce: 'test' }));
  const exitOf = (session: PtySession) => new Promise<number>((resolve) => session.onExit(resolve));

  beforeAll(async () => {
    // The first ConPTY spawn in a process is slow; warm it up like the daemon will.
    await exitOf(start({ file: cmdExe, args: ['/c', 'exit'], env: {} }));
  }, SLOW);

  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });

  test('answers DA1 itself, so a short command does not stall', async () => {
    const startedAt = performance.now();
    const session = start({ file: cmdExe, args: ['/c', 'ver'], env: {} });
    await exitOf(session);
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(session.screenText()).toContain('Microsoft Windows');
  }, SLOW);

  test.each<[ShellKind, string]>([
    ['powershell', '[Console]::OutputEncoding.CodePage; echo 中文输出\r'],
    ['cmd', 'chcp\recho 中文输出\r'],
    ['gitbash', 'chcp.com; echo 中文输出\r'],
  ])('%s runs in code page 65001 and round-trips Chinese', async (kind, command) => {
    const session = startShell(kind);
    session.write(command);
    // The output line must stand alone; the echoed command line also contains the text.
    await waitFor(() => /65001/.test(session.screenText()) && /^中文输出\s*$/m.test(session.screenText()), 15_000);
  }, SLOW);

  test('resize changes the size the shell sees', async () => {
    const session = startShell('powershell');
    session.resize(132, 40);
    session.write('$Host.UI.RawUI.WindowSize.Width\r');
    await waitFor(() => /^132\s*$/m.test(session.screenText()), 15_000);
  }, SLOW);

  test('numbers output chunks with contiguous byte offsets', async () => {
    const session = start({ file: cmdExe, args: ['/c', 'dir', '/s', paths.systemRoot + '\\Help'], env: {} });
    const chunks: { seq: number; length: number }[] = [];
    session.onOutput(({ seq, data }) => chunks.push({ seq, length: data.length }));
    await exitOf(session);
    let expected = chunks[0]?.seq ?? 0;
    for (const chunk of chunks) {
      expect(chunk.seq).toBe(expected);
      expected += chunk.length;
    }
    expect(session.seq).toBe(expected);
  }, SLOW);

  test('snapshot reproduces the current screen', async () => {
    // Snapshot after exit so no output can arrive between the snapshot and the comparison.
    const session = start({ file: cmdExe, args: ['/c', 'echo snapshot-check'], env: {} });
    await exitOf(session);
    await waitFor(() => /^snapshot-check\s*$/m.test(session.screenText()));
    const snapshot = await session.snapshot();
    expect(snapshot.seq).toBe(session.seq);
    const replica = new xtermHeadless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => replica.write(snapshot.data, resolve));
    const lines = Array.from({ length: snapshot.rows }, (_, i) => (replica.buffer.active.getLine(replica.buffer.active.viewportY + i)?.translateToString(true) ?? '').trimEnd());
    expect(lines.join('\n').trimEnd()).toBe(session.screenText());
  }, SLOW);

  test('reports the exit code', async () => {
    const session = start({ file: cmdExe, args: ['/c', 'exit 3'], env: {} });
    expect(await exitOf(session)).toBe(3);
  }, SLOW);

  test('kill ends the shell and reports exit', async () => {
    const session = startShell('powershell');
    const exited = exitOf(session);
    session.kill();
    await expect(exited).resolves.toEqual(expect.any(Number));
  }, SLOW);

  test('clamps resize to sane bounds and reports each size where it starts in the stream', async () => {
    const session = startShell('cmd');
    const sizes: { cols: number; rows: number }[] = [];
    session.onSize(({ cols, rows }) => sizes.push({ cols, rows }));
    session.resize(5000, 5000);
    await waitFor(() => session.size.cols === 1000);
    session.resize(0, 2.7);
    await waitFor(() => session.size.cols === 2);
    expect(sizes).toEqual([
      { cols: 1000, rows: 500 },
      { cols: 2, rows: 2 },
    ]);
    expect(session.sizeAt(session.seq)).toMatchObject({ cols: 2, rows: 2 });
    expect(session.sizeAt(0)).toMatchObject({ cols: 100, rows: 30 });
  }, SLOW);

  test('after a resize, new output lands on the rows where ConPTY puts it', async () => {
    const session = start(shellLaunchSpec('cmd', paths, { cwdNonce: 'test' }), { cols: 118, rows: 37 });
    session.write('echo one\r');
    await waitFor(() => /^one\s*$/m.test(session.screenText()) && /^one\n\n.*>$/m.test(session.screenText()), 15_000);
    const prompt = /^(.*>)echo one$/m.exec(session.screenText())![1]!;
    // Shrinking 37 -> 22 rows with the cursor on row 4: ConPTY moves the prompt row to the top.
    session.resize(118, 22);
    await waitFor(() => session.size.rows === 22);
    session.write('echo two\r');
    await waitFor(() => /^two\s*$/m.test(session.screenText()) && session.screenText().endsWith(prompt), 15_000);
    expect(session.screenText().split('\n')).toEqual([`${prompt}echo two`, 'two', '', prompt]);
    // Growing adds rows below; the cursor stays where it is.
    session.resize(118, 37);
    await waitFor(() => session.size.rows === 37);
    session.write('echo three\r');
    await waitFor(() => /^three\s*$/m.test(session.screenText()) && session.screenText().endsWith(prompt), 15_000);
    expect(session.screenText().split('\n')).toEqual([`${prompt}echo two`, 'two', '', `${prompt}echo three`, 'three', '', prompt]);
  }, SLOW);

  /** cmd at 118x37 after `echo one` … `echo six`. */
  const cmdWithEchoes = async () => {
    const session = start(shellLaunchSpec('cmd', paths, { cwdNonce: 'test' }), { cols: 118, rows: 37 });
    const words = ['one', 'two', 'three', 'four', 'five', 'six'];
    for (const word of words) {
      session.write(`echo ${word}\r`);
      await waitFor(() => new RegExp(`^${word}$`, 'm').test(session.screenText()), 15_000);
    }
    const prompt = /^(.*>)echo one$/m.exec(session.screenText())![1]!;
    return { session, words, prompt };
  };
  const resizeTo = async (session: PtySession, cols: number, rows: number) => {
    session.resize(cols, rows);
    await waitFor(() => session.size.cols === cols && session.size.rows === rows);
  };
  const echoed = (session: PtySession, prompt: string, word: string) =>
    waitFor(() => new RegExp(`^${word}$`, 'm').test(session.screenText()) && session.screenText().endsWith(prompt), 15_000);

  test('after width changes, the rows line up with ConPTY again and nothing is overwritten', async () => {
    const { session, words, prompt } = await cmdWithEchoes();
    let history = words;
    for (const [cols, rows, word] of [[100, 37, 'narrow'], [60, 30, 'smaller'], [118, 37, 'wide']] as const) {
      await resizeTo(session, cols, rows);
      session.write(`echo ${word}\r`);
      await echoed(session, prompt, word);
      history = [...history, word];
      expectEchoes(session.screenText(), prompt, history);
    }
    const lines = session.screenText().split('\n').filter((line) => line !== '');
    for (const line of lines) expect(line).toMatch(/^(?:[a-z]+|.*>(?:echo [a-z]+)?)$/);
  }, SLOW);

  test('a width change still lines up when a height change follows before the shell draws', async () => {
    const { session, words, prompt } = await cmdWithEchoes();
    await resizeTo(session, 100, 37);
    await resizeTo(session, 100, 30);
    session.write('echo after\r');
    await echoed(session, prompt, 'after');
    expectEchoes(session.screenText(), prompt, [...words, 'after']);
  }, SLOW);

  test('a height change after a width change lines up with ConPTY', async () => {
    // ConPTY's row rule for a height change shifts once its buffer has been reflowed.
    const { session, words, prompt } = await cmdWithEchoes();
    await resizeTo(session, 100, 37);
    session.write('echo mid\r');
    await echoed(session, prompt, 'mid');
    await resizeTo(session, 100, 30);
    session.write('echo after\r');
    await echoed(session, prompt, 'after');
    expectEchoes(session.screenText(), prompt, [...words, 'mid', 'after']);
  }, SLOW);

  test('output drawn while the next resize waits for quiet still lines up with an earlier width change', async () => {
    const { session, words, prompt } = await cmdWithEchoes();
    await resizeTo(session, 100, 37);
    session.write('echo during\r');
    await resizeTo(session, 100, 30); // asked for at once, so it waits while the echo is drawn
    await echoed(session, prompt, 'during');
    expectEchoes(session.screenText(), prompt, [...words, 'during']);
  }, SLOW);

  test('resizing and killing a session before its first output throws nothing later', async () => {
    // node-pty queues both calls until the first output; the queued resize used to throw
    // "Cannot resize a pty that has already exited" from inside node-pty, uncaught.
    const session = startShell('cmd');
    session.resize(100, 40);
    const exited = exitOf(session);
    session.kill();
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, SLOW);

  test('a throwing listener does not stop other listeners', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = start({ file: cmdExe, args: ['/c', 'echo isolated'], env: {} });
    session.onOutput(() => {
      throw new Error('boom');
    });
    let received = 0;
    session.onOutput(() => received++);
    await exitOf(session);
    expect(received).toBeGreaterThan(0);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  }, SLOW);

  test('pausing the pty while the mirror catches up loses no output', async () => {
    const session = start({ file: cmdExe, args: ['/c', 'dir', '/s', paths.systemRoot + '\\Help'], env: {} }, { mirrorHighWatermark: 256, mirrorLowWatermark: 64 });
    let expected = 0;
    session.onOutput(({ seq, data }) => {
      expect(seq).toBe(expected);
      expected += data.length;
    });
    await exitOf(session);
    const snapshot = await session.snapshot();
    expect(snapshot.seq).toBe(session.seq);
    expect(session.seq).toBeGreaterThan(256);
  }, SLOW);

  test('kill also ends detached processes the shell started', async () => {
    const session = startShell('powershell');
    session.write("(Start-Process ping -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru).Id\r");
    let grandchild = 0;
    await waitFor(() => {
      grandchild = Number(/^(\d+)\s*$/m.exec(session.screenText())?.[1] ?? 0);
      return grandchild > 0;
    }, 15_000);
    const exited = exitOf(session);
    session.kill();
    await exited;
    await waitFor(() => {
      try {
        process.kill(grandchild, 0);
        return false;
      } catch {
        return true;
      }
    });
  }, SLOW);


  test('read() returns the exact output stream from any retained offset', async () => {
    const session = start({ file: cmdExe, args: ['/c', 'echo ring-check'], env: {} });
    const chunks: Uint8Array[] = [];
    session.onOutput(({ data }) => chunks.push(data));
    await exitOf(session);
    const all = Buffer.concat(chunks);
    expect(Buffer.from(session.read(0)!).equals(all)).toBe(true);
    expect(Buffer.from(session.read(3, 4)!).equals(all.subarray(3, 7))).toBe(true);
    expect(session.read(session.seq + 1)).toBeUndefined();
  }, SLOW);

  test('read() reports output that has left a small ring', async () => {
    const session = start({ file: cmdExe, args: ['/c', 'dir', paths.systemRoot], env: {} }, { ringCapacity: 64 });
    await exitOf(session);
    expect(session.seq).toBeGreaterThan(64);
    expect(session.read(session.seq - 64)).toHaveLength(64);
    expect(session.read(session.seq - 65)).toBeUndefined();
    expect(session.read(0)).toBeUndefined();
  }, SLOW);

  test('a preloaded mirror keeps its history above the new shell', async () => {
    const mirror = new ScreenMirror({ cols: 100, rows: 30, scrollback: 100 });
    mirror.write('restored-line\r\n');
    await mirror.flush();
    const session = start({ file: cmdExe, args: ['/c', 'echo fresh-line'], env: {} }, { mirror });
    await exitOf(session);
    const snapshot = await session.snapshot();
    expect(snapshot.data).toContain('restored-line');
    expect(snapshot.data).toContain('fresh-line');
    expect(snapshot.data.indexOf('restored-line')).toBeLessThan(snapshot.data.indexOf('fresh-line'));
  }, SLOW);
});
