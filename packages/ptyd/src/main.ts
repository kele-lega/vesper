/**
 * vesper-ptyd: the long-lived terminal host. It owns every ConPTY session and
 * serves them on a named pipe to vesper-web, which can restart freely.
 *
 * Exit codes: 0 after a shutdown, 1 on a startup failure, 3 when another host
 * already serves the same VESPER_HOME.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { HOST_PROTOCOL_VERSION } from '@vesper/protocol';
import { Host } from './host.js';
import { log, setLogSink } from './log.js';
import { hostPaths, removeRunInfo, vesperHome, writeRunInfo, type HostPaths } from './paths.js';
import { startPipeServer, type PipeServer } from './server.js';
import { PtySession } from './session.js';
import type { ShellPaths } from './shells.js';
import { createProcessJob, type ProcessJob } from './windows-job.js';

const EXIT_STARTUP_FAILED = 1;
const EXIT_ALREADY_RUNNING = 3;
const FORCED_EXIT_MS = 10_000;
const WARM_UP_TIMEOUT_MS = 10_000;
const MAX_LOG_BYTES = 5 << 20;

/** Kept for the life of the process: closing it would end every shell. */
let selfJob: ProcessJob | undefined;

function shellPaths(env: NodeJS.ProcessEnv): ShellPaths {
  return {
    systemRoot: env['SystemRoot'] ?? 'C:\\Windows',
    gitBash: env['VESPER_GIT_BASH'] ?? 'C:\\Program Files\\Git\\bin\\bash.exe',
  };
}

function setUpLog(paths: HostPaths): void {
  mkdirSync(dirname(paths.logFile), { recursive: true });
  try {
    if (statSync(paths.logFile).size > MAX_LOG_BYTES) renameSync(paths.logFile, `${paths.logFile}.1`);
  } catch {
    // no log yet
  }
  setLogSink((line) => {
    try {
      appendFileSync(paths.logFile, `${line}\n`);
    } catch {
      // nowhere left to report it
    }
  });
  // A stray exception in one client's handler must not end every session.
  process.on('uncaughtException', (error) => log.error('uncaught exception', error));
  process.on('unhandledRejection', (error) => log.error('unhandled rejection', error));
}

/** The first ConPTY spawn in a process is slow; pay for it before anyone waits. */
async function warmUp(systemRoot: string): Promise<void> {
  const session = PtySession.spawn({
    launch: { file: `${systemRoot}\\System32\\cmd.exe`, args: ['/c', 'exit'], env: {} },
    cwd: systemRoot,
    cols: 80,
    rows: 24,
  });
  const exited = new Promise<void>((resolve) => session.onExit(() => resolve()));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, WARM_UP_TIMEOUT_MS).unref())]);
  session.dispose();
}

async function listen(paths: HostPaths, token: string, host: Host, stop: () => void): Promise<PipeServer> {
  try {
    return await startPipeServer({ pipe: paths.pipe, token, host, onShutdown: stop, startedAt: Date.now() });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    log.info(`another ptyd already serves ${paths.home}; exiting`);
    await host.shutdown();
    process.exit(EXIT_ALREADY_RUNNING);
  }
}

async function main(): Promise<void> {
  const paths = hostPaths(vesperHome());
  setUpLog(paths);
  if (process.platform === 'win32') {
    try {
      selfJob = createProcessJob({ killOnClose: true });
      selfJob.assign(process.pid);
    } catch (error) {
      log.warn('could not join a kill-on-close job; shells may outlive this host', error);
    }
  }
  const env = shellPaths(process.env);
  const token = randomBytes(32).toString('base64url');
  const host = new Host({ dataDir: paths.dataDir, shellPaths: env });
  let stopping: Promise<void> | undefined;
  let server: PipeServer | undefined;
  const stop = (): void => {
    stopping ??= (async () => {
      log.info('shutting down');
      setTimeout(() => process.exit(0), FORCED_EXIT_MS).unref();
      await host.shutdown();
      await server?.close();
      removeRunInfo(paths.runFile, process.pid);
      process.exit(0);
    })();
  };
  server = await listen(paths, token, host, stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(signal, stop);
  await warmUp(env.systemRoot).catch((error) => log.warn('ConPTY warm-up failed', error));
  await host.restore();
  // Clients learn the token only now, so none can act before the sessions are back.
  writeRunInfo(paths.runFile, { pid: process.pid, pipe: paths.pipe, token, protocol: HOST_PROTOCOL_VERSION, startedAt: Date.now() });
  log.info(`ptyd ${process.pid} ready on ${paths.pipe} with ${host.list().length} session(s)`);
}

main().catch((error) => {
  log.error('ptyd failed to start', error);
  process.exit(EXIT_STARTUP_FAILED);
});
