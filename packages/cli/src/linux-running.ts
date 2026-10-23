import { connect } from 'node:net';
import { join } from 'node:path';
import { hostPaths, readRunInfo } from '@vesper/ptyd/client';

function answers(address: number | string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = typeof address === 'number' ? connect(address, '127.0.0.1') : connect(address);
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => finish(true)); // A hung endpoint is not safe to replace.
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(new Error(`无法确认 Vesper 已停止：${error.message}`, { cause: error }));
    });
  });
}

export async function linuxRuntimeRunning(home: string): Promise<boolean> {
  const run = readRunInfo(join(home, 'run', 'ptyd.json'));
  if (run) {
    try {
      process.kill(run.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
    }
  }
  return (await answers(7690)) || answers(hostPaths(home).pipe);
}
