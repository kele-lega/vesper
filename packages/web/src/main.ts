/**
 * vesper-web: serves the UI and API on 127.0.0.1 and relays terminals from
 * vesper-ptyd, starting it when needed. Restarting web leaves every session running.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { log, setLogSink } from '@vesper/ptyd/client';
import { createApp } from './app.js';
import { AuthStore } from './auth-store.js';
import { loadConfig } from './config.js';
import { openWebDatabase } from './web-db.js';
import { HostSupervisor } from './supervisor.js';

/** A port that is free right now; VESPER_PORT=0 asks for one. */
function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const MAX_LOG_BYTES = 10 << 20;

/** Started hidden by the logon task (scripts/install.ts), web has no console: VESPER_LOG_FILE takes its lines. */
function logToFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
  const append = (line: string) => {
    try {
      appendFileSync(path, `${line}\n`);
    } catch {
      // nowhere left to report it
    }
  };
  setLogSink(append);
  console.log = (...parts: unknown[]) => append(`${new Date().toISOString()} info ${parts.join(' ')}`);
  console.error = (...parts: unknown[]) => append(`${new Date().toISOString()} error ${parts.join(' ')}`);
}

if (process.env['VESPER_LOG_FILE']) logToFile(process.env['VESPER_LOG_FILE']);
let config = loadConfig();
// The allowed origins and the CSP name the port, so it must be known before the app is built.
if (config.port === 0) config = loadConfig({ ...process.env, VESPER_PORT: String(await freePort(config.bind)) });
const supervisor = new HostSupervisor({ home: config.home });
const db = openWebDatabase(config.database);
const server = createApp(config, supervisor, { db });

server.on('error', (error) => {
  log.error('web server error', error);
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`Vesper: http://${config.bind}:${port}/`);
  if (!new AuthStore(db).passwordHash()) console.log('还没有设置密码：请先运行 npm run set-password');
  console.log('Sessions live in vesper-ptyd; stopping this server leaves them running.');
  supervisor.start().then(
    () => console.log('Terminal host ready.'),
    (error: Error) => {
      console.error(`Terminal host not ready yet: ${error.message}`);
      // An older ptyd keeps running its sessions but speaks an older protocol.
      if ((error as { code?: string }).code === 'version_mismatch') console.error('一个旧版终端主机还在运行：请运行 npm run stop-host，再重启 npm run demo。');
    },
  );
});

const stop = () => {
  supervisor.stop();
  server.close();
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop);
