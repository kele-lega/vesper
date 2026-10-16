#!/usr/bin/env node
import { vesperHome } from '@vesper/ptyd/client';
import { webDatabasePath } from '@vesper/web/auth';
import { setPassword } from './set-password.js';
import { readHidden } from './tty-prompt.js';

const USAGE = '用法：vesper set-password\n';

async function main(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== 'set-password') {
    process.stderr.write(USAGE);
    return 2;
  }
  const result = await setPassword(webDatabasePath(vesperHome()), (prompt) => readHidden(prompt));
  (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
  return result.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
