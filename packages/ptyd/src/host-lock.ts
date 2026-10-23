import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import koffi from 'koffi';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
// Linux O_CLOEXEC: the lock must never be inherited by shells or agents.
const O_CLOEXEC = 0o2000000;
let flock: ((fd: number, operation: number) => number) | undefined;

export function alreadyRunning(): NodeJS.ErrnoException {
  return Object.assign(new Error('another ptyd already owns this home'), { code: 'EADDRINUSE' });
}

/** The stable inode is never removed. The kernel releases its lock even after SIGKILL. */
export function lockHost(runDir: string): () => void {
  if (process.platform !== 'linux') return () => undefined;
  flock ??= koffi.load(null).func('int flock(int fd, int operation)') as (fd: number, operation: number) => number;
  const fd = openSync(join(runDir, 'ptyd.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | O_CLOEXEC, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1) throw new Error('unsafe ptyd lock file');
    fchmodSync(fd, 0o600);
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      const errno = koffi.errno();
      if (errno === 11) throw alreadyRunning(); // EAGAIN / EWOULDBLOCK
      throw new Error(`flock failed (errno ${errno})`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      flock!(fd, LOCK_UN);
    } finally {
      closeSync(fd);
    }
  };
}
