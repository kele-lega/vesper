import { spawn as spawnChild } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PtySession } from '../src/session.js';
import { createProcessJob, extendedLimitInfoSize, type ProcessJob } from '../src/windows-job.js';

const SLOW = 20_000;
const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.runIf(process.platform === 'win32')('Windows job objects', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const step of cleanup.splice(0).reverse()) step();
  });
  const track = (job: ProcessJob): ProcessJob => {
    cleanup.push(() => job.close());
    return job;
  };

  test('lays out JOBOBJECT_EXTENDED_LIMIT_INFORMATION like the x64 SDK', () => {
    expect(extendedLimitInfoSize()).toBe(144);
  });

  test('terminate ends the shell and processes it started after assignment', async () => {
    const session = PtySession.spawn({
      launch: { file: powershell, args: ['-NoLogo', '-NoProfile', '-NoExit'], env: {} },
      cwd: tmpdir(),
      cols: 120,
      rows: 30,
    });
    cleanup.push(() => session.kill());
    const job = track(createProcessJob({ killOnClose: false }));
    job.assign(session.pid);

    session.write("(Start-Process ping -ArgumentList '-n','60','127.0.0.1' -WindowStyle Hidden -PassThru).Id\r");
    let grandchild = 0;
    await waitFor(() => {
      grandchild = Number(/^(\d+)\s*$/m.exec(session.screenText())?.[1] ?? 0);
      return grandchild > 0;
    }, 15_000);
    expect(job.isMember(grandchild)).toBe(true);

    const exited = new Promise((resolve) => session.onExit(resolve));
    job.terminate(1);
    await exited;
    await waitFor(() => !isAlive(grandchild));
  }, SLOW);

  test('a kill-on-close job ends its members when the handle closes', async () => {
    const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanup.push(() => child.kill());
    const pid = child.pid ?? 0;
    const job = createProcessJob({ killOnClose: true });
    job.assign(pid);
    expect(job.isMember(pid)).toBe(true);
    job.close();
    await waitFor(() => !isAlive(pid));
  }, SLOW);

  test('assigning a process that does not exist throws', () => {
    const job = track(createProcessJob({ killOnClose: false }));
    expect(() => job.assign(0x7ffffff0)).toThrow(/OpenProcess/);
  });

  test('a closed job rejects further use', () => {
    const job = createProcessJob({ killOnClose: false });
    job.close();
    expect(() => job.terminate(1)).toThrow(/closed/);
    expect(() => job.close()).not.toThrow();
  });
});
