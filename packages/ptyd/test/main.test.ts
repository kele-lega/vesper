import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { encodeFrame, type Frame } from '@vesper/protocol';
import { AttachChannel, ControlClient, hostPaths, readRunInfo, type HostAddress, type RunInfo } from '../src/client.js';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const SLOW = 90_000;

async function waitFor(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
const exitOf = (child: ChildProcess) =>
  hasExited(child) ? Promise.resolve(child.exitCode) : new Promise<number | null>((resolve) => child.once('exit', resolve));

describe.runIf(process.platform === 'win32')('ptyd process', () => {
  const homes: string[] = [];
  const children: ChildProcess[] = [];
  const clients: { close(): void }[] = [];
  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'vesper-ptyd-'));
    homes.push(home);
    return home;
  };
  const launch = (home: string): ChildProcess => {
    const child = spawn(process.execPath, ['--import', 'tsx', MAIN], { env: { ...process.env, VESPER_HOME: home }, stdio: 'ignore' });
    children.push(child);
    return child;
  };
  const start = async (home: string): Promise<{ child: ChildProcess; run: RunInfo; address: HostAddress }> => {
    const child = launch(home);
    const runFile = hostPaths(home).runFile;
    await waitFor(() => readRunInfo(runFile)?.pid === child.pid || hasExited(child));
    const run = readRunInfo(runFile);
    if (!run || run.pid !== child.pid) throw new Error(`ptyd exited with ${child.exitCode}`);
    return { child, run, address: { pipe: run.pipe, token: run.token } };
  };
  const control = async (address: HostAddress) => {
    const client = await ControlClient.connect(address);
    clients.push(client);
    return client;
  };
  const attach = async (address: HostAddress, session: string) => {
    const channel = await AttachChannel.open(address, { session });
    clients.push(channel);
    const frames: Frame[] = [];
    channel.onFrame((frame) => frames.push(frame));
    const text = () =>
      frames.map((f) => (f.type === 'output' || f.type === 'snapshot' ? Buffer.from(f.data).toString('utf8') : '')).join('');
    const type = (input: string) => channel.sendRaw(encodeFrame({ type: 'input', data: Buffer.from(input, 'utf8') }));
    return { channel, frames, text, type };
  };

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const child of children.splice(0)) {
      if (!hasExited(child)) child.kill();
      await exitOf(child);
    }
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('serves control and attach connections to holders of the token', async () => {
    const { address } = await start(newHome());
    const client = await control(address);
    expect(await client.list()).toEqual([]);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.event));
    const session = await client.create({ shell: 'cmd', cwd: tmpdir() });
    const view = await attach(address, session.id);
    await waitFor(() => view.frames[0]?.type === 'snapshot');
    view.type('echo piped-%OS%\r');
    await waitFor(() => view.text().includes('piped-Windows_NT'));
    expect((await client.ping()).pid).toBeGreaterThan(0);
    expect(events).toContain('session');
  }, SLOW);

  test('a second host for the same home exits and leaves the first serving', async () => {
    const home = newHome();
    const { address } = await start(home);
    const second = launch(home);
    expect(await exitOf(second)).toBe(3);
    expect(await (await control(address)).list()).toEqual([]);
  }, SLOW);

  test('after a shutdown, the next host restarts the session below its history', async () => {
    const home = newHome();
    const first = await start(home);
    const client = await control(first.address);
    const { id } = await client.create({ shell: 'cmd', cwd: tmpdir() });
    const view = await attach(first.address, id);
    view.type('echo kept-%OS%\r');
    await waitFor(() => view.text().includes('kept-Windows_NT'));
    await client.shutdown();
    expect(await exitOf(first.child)).toBe(0);

    const second = await start(home);
    const sessions = await (await control(second.address)).list();
    expect(sessions).toEqual([expect.objectContaining({ id, status: 'running', inc: 2 })]);
    const again = await attach(second.address, id);
    await waitFor(() => again.text().includes('kept-Windows_NT') && again.text().includes('已恢复历史'));
  }, SLOW);

  test('after a hard kill, the next host restores from the log', async () => {
    const home = newHome();
    const first = await start(home);
    const client = await control(first.address);
    const { id } = await client.create({ shell: 'cmd', cwd: tmpdir() });
    const view = await attach(first.address, id);
    view.type('echo crash-safe-%OS%\r');
    await waitFor(() => view.text().includes('crash-safe-Windows_NT'));
    await new Promise((resolve) => setTimeout(resolve, 1500)); // one log flush
    first.child.kill();
    await exitOf(first.child);

    const second = await start(home);
    const again = await attach(second.address, id);
    await waitFor(() => again.text().includes('crash-safe-Windows_NT'));
    expect((await (await control(second.address)).list())[0]).toMatchObject({ id, status: 'running', inc: 2 });
  }, SLOW);
});
