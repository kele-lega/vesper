/**
 * vesper-web: serves the UI and API on 127.0.0.1 and relays terminals from
 * vesper-ptyd, starting it when needed. Restarting web leaves every session running.
 */
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { log } from '@vesper/ptyd/client';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
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

let config = loadConfig();
// The allowed origins and the CSP name the port, so it must be known before the app is built.
if (config.port === 0) config = loadConfig({ ...process.env, VESPER_PORT: String(await freePort(config.bind)) });
const supervisor = new HostSupervisor({ home: config.home });
const server = createApp(config, supervisor);

server.on('error', (error) => {
  log.error('web server error', error);
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  // The token sits in the fragment, so it never reaches a server log or a Referer header.
  console.log(`Vesper: http://${config.bind}:${port}/#token=${config.token}`);
  console.log('Sessions live in vesper-ptyd; stopping this server leaves them running.');
  supervisor.start().then(
    () => console.log('Terminal host ready.'),
    (error: Error) => console.error(`Terminal host not ready yet: ${error.message}`),
  );
});

const stop = () => {
  supervisor.stop();
  server.close();
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop);
