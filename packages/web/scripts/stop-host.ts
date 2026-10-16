/**
 * Asks the running vesper-ptyd to save every session and exit; its shells end.
 * If vesper-web is still running, it starts a fresh host at once, which brings the
 * sessions back below their history. Without vesper-web, the host simply stays stopped.
 *
 *   npm run stop-host
 */
import { ControlClient, hostPaths, readRunInfo, vesperHome } from '@vesper/ptyd/client';

const run = readRunInfo(hostPaths(vesperHome()).runFile);
if (!run) {
  console.log('No terminal host is running.');
  process.exit(0);
}
try {
  const client = await ControlClient.connect({ pipe: run.pipe, token: run.token });
  await client.shutdown();
  console.log(`Asked the terminal host (pid ${run.pid}) to save its sessions and exit.`);
} catch (error) {
  if ((error as { code?: string }).code !== 'version_mismatch') {
    console.log(`No terminal host answered (${(error as Error).message}).`);
    process.exit(0);
  }
  // A host from an older Vesper cannot be asked to exit. Its sessions are saved as they run,
  // so ending it loses only output from the last moment; the next host restores them.
  process.kill(run.pid);
  console.log(`Stopped an older terminal host (pid ${run.pid}); the new one will restore its sessions.`);
}
