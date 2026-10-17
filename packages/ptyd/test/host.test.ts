import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Frame, HostEvent } from '@vesper/protocol';
import type { AttachPeer } from '../src/attachment.js';
import { cleanTitle, localDirectory } from '../src/hosted-session.js';
import { Host } from '../src/host.js';
import { hostIsElevated } from '../src/launcher.js';

const SLOW = 30_000;
const shellPaths = {
  systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
  gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe',
};
const timing = { flushMs: 50, checkpointMs: 200, metaMs: 20 };

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

class Peer implements AttachPeer {
  frames: Frame[] = [];
  closed = false;
  send(frame: Frame): void {
    this.frames.push(frame);
  }
  close(): void {
    this.closed = true;
  }
  text(): string {
    return this.frames
      .map((frame) => (frame.type === 'snapshot' || frame.type === 'output' ? Buffer.from(frame.data).toString('utf8') : ''))
      .join('');
  }
  find<T extends Frame['type']>(type: T): Extract<Frame, { type: T }> | undefined {
    return this.frames.find((frame) => frame.type === type) as Extract<Frame, { type: T }> | undefined;
  }
}

const typeInto = (attachment: { receive(frame: Frame): void }, text: string) =>
  attachment.receive({ type: 'input', data: Buffer.from(text, 'utf8') });
const samePath = (a: string, b: string) => a.toLowerCase().replace(/\\$/, '') === b.toLowerCase().replace(/\\$/, '');

describe.runIf(process.platform === 'win32')('Host', () => {
  const dirs: string[] = [];
  const hosts: Host[] = [];
  const tempDir = (): string => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'vesper-host-')));
    dirs.push(dir);
    return dir;
  };
  const newHost = (dataDir: string, paths = shellPaths): Host => {
    const host = new Host({ dataDir, shellPaths: paths, timing, scrollback: 500 });
    hosts.push(host);
    return host;
  };
  const shutdown = async (host: Host) => {
    hosts.splice(hosts.indexOf(host), 1);
    await host.shutdown();
  };

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('creates a session that streams a snapshot, then live output, and takes input', async () => {
    const host = newHost(tempDir());
    const events: HostEvent[] = [];
    host.onEvent((event) => events.push(event));
    const info = host.create({ shell: 'cmd', cwd: tempDir() });
    expect(info).toMatchObject({ shell: 'cmd', status: 'running', inc: 1, cols: 120, rows: 30, attached: 0 });
    const peer = new Peer();
    const attachment = host.get(info.id)!.attach(peer, {});
    await waitFor(() => peer.find('snapshot') !== undefined);
    typeInto(attachment, 'echo live-%OS%\r');
    await waitFor(() => peer.text().includes('live-Windows_NT'));
    expect(host.list()).toEqual([expect.objectContaining({ id: info.id, attached: 1 })]);
    expect(events.some((event) => event.event === 'session' && event.session.attached === 1)).toBe(true);
  }, SLOW);

  test('raises the notifications a program asks for as notice events', async () => {
    const host = newHost(tempDir());
    const events: HostEvent[] = [];
    host.onEvent((event) => events.push(event));
    const { id } = host.create({ shell: 'cmd', cwd: tempDir() });
    const peer = new Peer();
    const attachment = host.get(id)!.attach(peer, {});
    await waitFor(() => peer.text().includes('>'));
    // cmd has no way to print ESC except through its prompt: $e is ESC.
    typeInto(attachment, 'prompt $e]9;tests done$e\\$e]777;notify;Build;failed$e\\$g\r');
    await waitFor(() => events.filter((event) => event.event === 'notice').length >= 2);
    expect(events.filter((event) => event.event === 'notice').slice(0, 2)).toEqual([
      { event: 'notice', session: id, title: '', body: 'tests done', at: expect.any(Number) },
      { event: 'notice', session: id, title: 'Build', body: 'failed', at: expect.any(Number) },
    ]);
  }, SLOW);

  test('a launch command runs in place of a shell, and restart starts it again below its history', async () => {
    const host = newHost(tempDir());
    const info = host.create({ command: { commandLine: 'echo command-ran %VESPER_DEMO% & set /p x=', env: { VESPER_DEMO: 'env-ok' }, label: 'Demo' }, cwd: tempDir() });
    expect(info).toMatchObject({ shell: null, title: 'Demo', status: 'running' });
    await expect(host.restart(info.id)).rejects.toMatchObject({ code: 'bad_request' });
    expect(() => host.restart('nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
    const peer = new Peer();
    host.get(info.id)!.attach(peer, {});
    await waitFor(() => peer.text().includes('command-ran env-ok'));
    host.kill(info.id);
    await waitFor(() => host.list()[0]?.status === 'exited');

    const restarted = await host.restart(info.id);
    expect(restarted).toMatchObject({ status: 'running', exitCode: null, inc: 2 });
    expect(peer.frames.at(-1)).toEqual({ type: 'closed', reason: 'restarted' });
    const again = new Peer();
    host.get(info.id)!.attach(again, {});
    await waitFor(() => (again.text().match(/command-ran env-ok/g) ?? []).length === 2);
    expect(again.text()).toContain('重新启动');
  }, SLOW);

  test('starts a program file with its arguments', async () => {
    const host = newHost(tempDir());
    const cmd = `${shellPaths.systemRoot}\\System32\\cmd.exe`;
    const { id } = host.create({ command: { file: cmd, args: ['/d', '/c', 'echo', 'two words', '&', 'set', '/p', 'x='], label: 'cmd' }, cwd: tempDir() });
    const peer = new Peer();
    host.get(id)!.attach(peer, {});
    await waitFor(() => peer.text().includes('"two words"'));
  }, SLOW);

  test('a restarted host leaves a launch command ended below its history, ready to restart', async () => {
    const dataDir = tempDir();
    const first = newHost(dataDir);
    const { id } = first.create({ command: { commandLine: 'echo agent-said-hi & set /p x=', label: 'Agent' }, cwd: tempDir() });
    const peer = new Peer();
    first.get(id)!.attach(peer, {});
    await waitFor(() => peer.text().includes('agent-said-hi'));
    await shutdown(first);

    const second = newHost(dataDir);
    await second.restore();
    expect(second.list()).toEqual([expect.objectContaining({ id, status: 'exited', exitCode: null, inc: 1 })]);
    const viewer = new Peer();
    second.get(id)!.attach(viewer, {});
    await waitFor(() => viewer.find('exit') !== undefined);
    expect(viewer.text()).toMatch(/agent-said-hi[\s\S]*Vesper 重启，程序已结束/);
    await shutdown(second);

    const third = newHost(dataDir);
    await third.restore();
    expect(third.list()).toEqual([expect.objectContaining({ id, status: 'exited' })]);
    expect(await third.restart(id)).toMatchObject({ status: 'running', inc: 2 });
  }, SLOW);

  // Only an elevated host has a token to lower; the suite runs elevated on the built-in Administrator.
  test.runIf(hostIsElevated())('"normal" sessions run at Medium integrity without admin rights, and kill still ends the whole tree', async () => {
    const dataDir = tempDir();
    const host = new Host({ dataDir, shellPaths, timing, scrollback: 500, binDir: join(dataDir, 'bin') });
    hosts.push(host);
    const probe = `${shellPaths.systemRoot}\\vesper-probe-${process.pid}.txt`;
    const system32 = `${shellPaths.systemRoot}\\System32`;
    // findstr's exit code, not its output: ConPTY may break a long line with cursor moves.
    const has = (sid: string, word: string) => `(${system32}\\whoami.exe /groups | ${system32}\\findstr.exe /c:"${sid}" >nul && echo ${word}-yes || echo ${word}-no)`;
    const line = `echo dir=%CD%=launch=%VESPER_LAUNCH_CWD%= & ${has('S-1-16-8192', 'medium')} & ${has('S-1-16-12288', 'high')} & (echo x>"${probe}") 2>nul && echo WROTE || echo REFUSED & ping -n 600 127.0.0.77 >nul`;
    const cwd = tempDir();
    const { id, elevation } = host.create({ command: { commandLine: line, label: 'probe' }, cwd, elevation: 'normal' });
    expect(elevation).toBe('normal');
    const peer = new Peer();
    host.get(id)!.attach(peer, {});
    await waitFor(() => /REFUSED|WROTE/.test(peer.text()), 30_000);
    expect(peer.text()).toContain('medium-yes'); // Medium Mandatory Level
    expect(peer.text()).toContain('high-no');
    expect(peer.text()).toContain('REFUSED'); // C:\Windows grants writes to Administrators only
    expect(existsSync(probe)).toBe(false);
    // The child starts in the session's directory; the launcher's own directory variable is not passed on.
    expect(peer.text()).toContain(`dir=${cwd}=launch=%VESPER_LAUNCH_CWD%=`);

    // The launcher's child joined the session's job, so the ping it started ends too.
    const pings = () =>
      Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process -Name PING -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).trim());
    await waitFor(() => pings() > 0, 15_000);
    host.kill(id);
    await waitFor(() => pings() === 0, 15_000);
  }, SLOW);

  test.runIf(hostIsElevated())('an elevated host refuses "normal" sessions it cannot isolate, instead of running them as admin', () => {
    const dataDir = tempDir();
    const blocked = new Host({ dataDir, shellPaths, timing, binDir: join(dataDir, 'bin'), normalBlocked: () => 'the home is open' });
    hosts.push(blocked);
    expect(() => blocked.create({ shell: 'cmd', cwd: tempDir(), elevation: 'normal' })).toThrow(/could not start cmd: normal-privilege sessions are disabled: the home is open/);
    const noBin = newHost(tempDir());
    expect(() => noBin.create({ shell: 'cmd', cwd: tempDir(), elevation: 'normal' })).toThrow(/no folder to build vesper-launch/);
    expect(noBin.create({ shell: 'cmd', cwd: tempDir(), elevation: 'admin' }).status).toBe('running');
  });

  test('kill ends the shell and keeps the session with its exit code', async () => {
    const host = newHost(tempDir());
    const { id } = host.create({ shell: 'cmd', cwd: tempDir() });
    const peer = new Peer();
    host.get(id)!.attach(peer, {});
    await waitFor(() => peer.text().includes('>'));
    host.kill(id);
    await waitFor(() => peer.find('exit') !== undefined);
    await waitFor(() => host.list()[0]?.status === 'exited');
    expect(host.list()[0]?.exitCode).not.toBeNull();
  }, SLOW);

  test('remove closes attached clients and deletes the files', async () => {
    const dataDir = tempDir();
    const host = newHost(dataDir);
    const events: HostEvent[] = [];
    host.onEvent((event) => events.push(event));
    const { id } = host.create({ shell: 'cmd', cwd: tempDir() });
    const peer = new Peer();
    host.get(id)!.attach(peer, {});
    await waitFor(() => peer.text().includes('>'));
    host.remove(id);
    expect(peer.frames.at(-1)).toEqual({ type: 'closed', reason: 'removed' });
    expect(peer.closed).toBe(true);
    expect(host.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ event: 'removed', session: id });
    await waitFor(() => !existsSync(join(dataDir, 'sessions', id)));
  }, SLOW);

  test('rejects bad directories, unknown sessions and shells that cannot start', () => {
    const host = newHost(tempDir(), { ...shellPaths, gitBash: 'C:\\missing\\bash.exe' });
    expect(() => host.create({ shell: 'cmd', cwd: 'relative\\dir' })).toThrow(expect.objectContaining({ code: 'bad_cwd' }));
    expect(() => host.create({ shell: 'cmd', cwd: 'C:\\no\\such\\dir' })).toThrow(expect.objectContaining({ code: 'bad_cwd' }));
    expect(() => host.kill('nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => host.remove('nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => host.create({ shell: 'gitbash', cwd: tempDir() })).toThrow(expect.objectContaining({ code: 'spawn_failed' }));
    expect(host.list()).toEqual([]);
  });

  test.each(['cmd', 'powershell', 'gitbash'] as const)('%s reports its directory through OSC 9;9', async (shell) => {
    const host = newHost(tempDir());
    const parent = tempDir();
    const child = join(parent, '子目录 a');
    mkdirSync(child);
    const { id } = host.create({ shell, cwd: child });
    const peer = new Peer();
    const attachment = host.get(id)!.attach(peer, {});
    await waitFor(() => samePath(host.get(id)!.info().cwd, child), 20_000);
    typeInto(attachment, 'cd ..\r');
    await waitFor(() => samePath(host.get(id)!.info().cwd, parent), 20_000);
  }, SLOW);

  test('output cannot pass for the prompt hook: a forged directory report is ignored', async () => {
    const host = newHost(tempDir());
    const cwd = tempDir();
    const seen: string[] = [];
    host.onEvent((event) => {
      if (event.event === 'session') seen.push(event.session.cwd);
    });
    const { id } = host.create({ shell: 'gitbash', cwd });
    const peer = new Peer();
    const attachment = host.get(id)!.attach(peer, {});
    await waitFor(() => samePath(host.get(id)!.info().cwd, cwd), 20_000);
    // A program printing the report with a guessed nonce, and one with an unsafe path.
    typeInto(attachment, "printf '\\033]7690;cwd;guessed;C:\\\\Windows\\007'; echo printed-$((6*7))\r");
    await waitFor(() => peer.text().includes('printed-42'), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.some((path) => samePath(path, 'C:\\Windows'))).toBe(false);
    expect(samePath(host.get(id)!.info().cwd, cwd)).toBe(true);
  }, SLOW);

  test('the size follows the device that typed last', async () => {
    const host = newHost(tempDir());
    const { id } = host.create({ shell: 'cmd', cwd: tempDir() });
    const session = host.get(id)!;
    const desk = new Peer();
    const laptop = new Peer();
    session.attach(desk, { size: { cols: 100, rows: 30 } });
    const fromLaptop = session.attach(laptop, { size: { cols: 80, rows: 20 } });
    await waitFor(() => desk.find('snapshot') !== undefined && laptop.find('snapshot') !== undefined);
    await waitFor(() => session.info().cols === 100 && session.info().rows === 30);
    typeInto(fromLaptop, '\x1b[I\x1b[O'); // focus reports are not typing
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(session.info()).toMatchObject({ cols: 100, rows: 30 });
    typeInto(fromLaptop, ' ');
    await waitFor(() => session.info().cols === 80 && session.info().rows === 20);
    await waitFor(() => desk.frames.some((frame) => frame.type === 'size' && frame.cols === 80 && frame.rows === 20));
  }, SLOW);

  test('a restarted host brings a running session back below its history, in its last directory', async () => {
    const dataDir = tempDir();
    const parent = tempDir();
    const child = join(parent, 'next');
    mkdirSync(child);
    const first = newHost(dataDir);
    const { id } = first.create({ shell: 'cmd', cwd: parent });
    const peer = new Peer();
    const attachment = first.get(id)!.attach(peer, {});
    typeInto(attachment, 'cd next\recho before-restart-%OS%\r');
    await waitFor(() => peer.text().includes('before-restart-Windows_NT') && samePath(first.get(id)!.info().cwd, child));
    await shutdown(first);

    const second = newHost(dataDir);
    await second.restore();
    expect(second.list()).toEqual([expect.objectContaining({ id, status: 'running', inc: 2 })]);
    expect(samePath(second.list()[0]!.cwd, child)).toBe(true);
    const again = new Peer();
    second.get(id)!.attach(again, { resume: { inc: 1, seq: 0 } });
    await waitFor(() => again.find('snapshot') !== undefined);
    const snapshot = Buffer.from(again.find('snapshot')!.data).toString('utf8');
    expect(snapshot).toContain('before-restart-Windows_NT');
    expect(snapshot).toContain('已恢复历史');
    expect(again.find('snapshot')!.inc).toBe(2);
    await waitFor(() => again.text().includes(`${child}>`));
  }, SLOW);

  test('a removed session stays removed, and leftover files of removed sessions are swept on start', async () => {
    const dataDir = tempDir();
    const first = newHost(dataDir);
    const { id } = first.create({ shell: 'cmd', cwd: tempDir() });
    first.remove(id);
    await shutdown(first);
    // Files a virus scanner held open while the session was removed.
    mkdirSync(join(dataDir, 'sessions', 'leftoverSession1'), { recursive: true });
    mkdirSync(join(dataDir, 'sessions', 'not a session id'), { recursive: true });

    const second = newHost(dataDir);
    await second.restore();
    expect(second.list()).toEqual([]);
    expect(existsSync(join(dataDir, 'sessions', 'leftoverSession1'))).toBe(false);
    expect(existsSync(join(dataDir, 'sessions', 'not a session id'))).toBe(true);
  }, SLOW);

  test('a session that exited stays viewable with its exit code after a restart', async () => {
    const dataDir = tempDir();
    const first = newHost(dataDir);
    const { id } = first.create({ shell: 'cmd', cwd: tempDir() });
    const peer = new Peer();
    const attachment = first.get(id)!.attach(peer, {});
    typeInto(attachment, 'echo last-words-%OS%\rexit 5\r');
    await waitFor(() => peer.find('exit') !== undefined);
    await waitFor(() => first.list()[0]?.status === 'exited');
    await shutdown(first);

    const second = newHost(dataDir);
    await second.restore();
    expect(second.list()).toEqual([expect.objectContaining({ id, status: 'exited', exitCode: 5 })]);
    const again = new Peer();
    second.get(id)!.attach(again, {});
    await waitFor(() => again.find('exit') !== undefined);
    expect(again.frames.map((frame) => frame.type)).toEqual(['snapshot', 'exit']);
    expect(again.text()).toContain('last-words-Windows_NT');
    expect(again.find('exit')).toEqual({ type: 'exit', code: 5 });
  }, SLOW);
});

describe('reported directories and titles', () => {
  test.each([
    ['C:\\work', 'C:\\work'],
    ['d:\\代码\\项目', 'd:\\代码\\项目'],
  ])('accepts the local path %s', (path, expected) => {
    expect(localDirectory(path)).toBe(expected);
  });

  test.each(['\\\\attacker\\share', '\\\\?\\C:\\x', 'relative\\dir', '/c/Users', 'C:', `C:\\${'x'.repeat(1100)}`, 'C:\\a\u0007b'])(
    'rejects %s',
    (path) => {
      expect(localDirectory(path)).toBeUndefined();
    },
  );

  test('titles lose control and bidirectional-override characters and stay short', () => {
    expect(cleanTitle('evil\u202egnp.exe\u0007 ok')).toBe('evilgnp.exe ok');
    expect(cleanTitle('x'.repeat(300))).toHaveLength(256);
  });
});
