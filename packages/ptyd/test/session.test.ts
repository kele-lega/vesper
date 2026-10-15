import { tmpdir } from 'node:os';
import xtermHeadless from '@xterm/headless';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
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

describe.runIf(process.platform === 'win32')('PtySession on ConPTY', () => {
  const sessions: PtySession[] = [];
  const start = (launch: LaunchSpec, overrides: Partial<SessionOptions> = {}): PtySession => {
    const session = PtySession.spawn({ launch, cwd: tmpdir(), cols: 100, rows: 30, ...overrides });
    sessions.push(session);
    return session;
  };
  const startShell = (kind: ShellKind) => start(shellLaunchSpec(kind, paths));
  const exitOf = (session: PtySession) => new Promise<number>((resolve) => session.onExit(resolve));

  beforeAll(async () => {
    // The first ConPTY spawn in a process is slow; warm it up like the daemon will.
    await exitOf(start({ file: cmdExe, args: ['/c', 'exit'], env: {} }));
  }, SLOW);

  afterEach(() => {
    for (const session of sessions.splice(0)) session.kill();
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
    const lines = Array.from({ length: snapshot.rows }, (_, i) => replica.buffer.active.getLine(replica.buffer.active.viewportY + i)?.translateToString(true) ?? '');
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
});
