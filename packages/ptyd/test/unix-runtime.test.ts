import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ControlClient } from '../src/client.js';
import { Host } from '../src/host.js';
import { lockHost } from '../src/host-lock.js';
import { hostPaths, prepareHome, writeRunInfo } from '../src/paths.js';
import { startPipeServer, type PipeServer } from '../src/server.js';
import { PtySession } from '../src/session.js';
import { prepareSocketPath } from '../src/unix-socket.js';

const shellPaths = { systemRoot: '', gitBash: '' };
const SLOW = 20_000;

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Linux terminal');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Real Linux-only probes. Windows unit/spec tests do not stand in for these. */
describe.runIf(process.platform === 'linux')('Linux runtime', () => {
  const dirs: string[] = [];
  const sessions: PtySession[] = [];
  const hosts: Host[] = [];
  const servers: PipeServer[] = [];
  const clients: ControlClient[] = [];
  const unlocks: (() => void)[] = [];
  function home(): string {
    const path = mkdtempSync(join(tmpdir(), 'vl-'));
    dirs.push(path);
    prepareHome(path);
    return path;
  }
  function session(command: string): PtySession {
    const pty = PtySession.spawn({ launch: { file: '/bin/sh', args: ['-c', command], env: {} }, cwd: home(), cols: 80, rows: 24 });
    sessions.push(pty);
    return pty;
  }
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) await server.close();
    for (const host of hosts.splice(0)) await host.shutdown();
    for (const pty of sessions.splice(0)) pty.dispose();
    for (const unlock of unlocks.splice(0)) unlock();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('protects an existing home and token and holds a kernel single-instance lock', () => {
    const path = home();
    chmodSync(path, 0o755);
    prepareHome(path);
    const paths = hostPaths(path);
    writeRunInfo(paths.runFile, { pid: process.pid, pipe: paths.pipe, token: 'secret', protocol: 7, startedAt: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(paths.runFile).mode & 0o777).toBe(0o600);
    const unlock = lockHost(join(path, 'run'));
    unlocks.push(unlock);
    expect(() => lockHost(join(path, 'run'))).toThrow(expect.objectContaining({ code: 'EADDRINUSE' }));
    unlock();
    unlocks.push(lockHost(join(path, 'run')));
  });

  test('serves authenticated Unix IPC and never deletes an active socket or ordinary file', async () => {
    const path = home();
    const host = new Host({ dataDir: join(path, 'data'), shellPaths });
    hosts.push(host);
    const pipe = hostPaths(path).pipe;
    servers.push(await startPipeServer({ pipe, token: 'token', host, onShutdown: () => undefined }));
    await expect(prepareSocketPath(pipe)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(existsSync(pipe)).toBe(true);
    await expect(ControlClient.connect({ pipe, token: 'wrong' })).rejects.toThrow();
    const client = await ControlClient.connect({ pipe, token: 'token' });
    clients.push(client);
    expect(await client.list()).toEqual([]);
    const created = await client.create({ shell: 'sh', cwd: path, elevation: 'admin' });
    expect(created).toMatchObject({ status: 'running', elevation: 'normal', shell: 'sh' });
    await expect(client.create({ shell: 'cmd', cwd: path, elevation: 'normal' })).rejects.toThrow(/not supported/);
    await client.remove(created.id);
    const regular = join(path, 'run', 'not-a-socket');
    writeFileSync(regular, 'keep');
    await expect(prepareSocketPath(regular)).rejects.toThrow(/refusing/);
    expect(readFileSync(regular, 'utf8')).toBe('keep');
  }, SLOW);

  test('resizes a silent pty before first output and reports signal exits as failures', async () => {
    const pty = session('sleep 0.2; stty size; kill -TERM $$');
    pty.resize(111, 35);
    const code = await new Promise<number>((resolve) => pty.onExit(resolve));
    await pty.mirror.flush();
    expect(pty.screenText()).toContain('35 111');
    expect(code).toBe(143);
  }, SLOW);

  test('clears background processes in a different process group when the tab is killed', async () => {
    // Bash job control gives the background job a distinct PGID in the same terminal SID.
    const pidFile = join(home(), 'child.pid');
    const pty = PtySession.spawn({
      launch: { file: '/bin/bash', args: ['--noprofile', '--norc', '-c', 'set -m; sleep 60 & printf "%s" "$!" > "$PID_FILE"; wait'], env: { PID_FILE: pidFile } },
      cwd: home(), cols: 80, rows: 24,
    });
    sessions.push(pty);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try {
      pty.kill();
      await waitFor(() => {
        try { return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
        catch { return true; }
      });
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
  }, SLOW);

  test('bash hooks preserve string and array PROMPT_COMMAND and remove exported nonce', async () => {
    for (const prompt of ["PROMPT_COMMAND='printf original-hook'", "PROMPT_COMMAND=('printf original-hook' 'true')"]) {
      const path = home();
      const config = home();
      writeFileSync(join(config, '.bash_profile'), `${prompt}\nPS1='vesper-test> '\n`);
      // Direct launch exercises the prompt hook with a private HOME.
      const { shellLaunchSpec } = await import('../src/shells.js');
      const launch = shellLaunchSpec('bash', shellPaths, { cwdNonce: 'integration_nonce', integrationDir: join(path, 'shell') });
      const pty = PtySession.spawn({ launch: { ...launch, env: { ...launch.env, HOME: config } }, cwd: path, cols: 100, rows: 24 });
      sessions.push(pty);
      const reported: string[] = [];
      pty.mirror.onCwd(({ path: cwd }) => reported.push(cwd));
      await waitFor(() => pty.screenText().includes('original-hook'));
      pty.write('cd /; printf "nonce=%s\\n" "${VESPER_CWD_NONCE-unset}"\r');
      await waitFor(() => reported.includes('/') && pty.screenText().includes('nonce=unset'));
      expect(pty.screenText()).toContain('original-hook');
      pty.kill();
    }
  }, SLOW);
});
