import { lstatSync, unlinkSync, type Stats } from 'node:fs';
import { connect } from 'node:net';
import { alreadyRunning } from './host-lock.js';

const PROBE_TIMEOUT_MS = 1000;

function socketStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Called only while holding the home lock. Never unlink a live or unidentifiable listener. */
export async function prepareSocketPath(path: string): Promise<void> {
  const before = socketStat(path);
  if (!before) return;
  if (!before.isSocket() || before.uid !== process.getuid!()) throw new Error(`refusing to replace a non-owned socket: ${path}`);
  const refused = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    const finish = (result: boolean, error?: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish(false);
      else if (error.code === 'ECONNREFUSED') finish(true);
      else finish(false, error);
    });
  });
  if (!refused) throw alreadyRunning();
  const current = socketStat(path);
  if (!current) return;
  if (!current.isSocket() || current.ino !== before.ino || current.dev !== before.dev) throw alreadyRunning();
  unlinkSync(path);
}
