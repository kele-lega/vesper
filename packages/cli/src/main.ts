#!/usr/bin/env node
import { vesperHome } from '@vesper/ptyd/client';
import { webDatabasePath } from '@vesper/web/auth';
import { deploy, parseDeployArgs, undeploy } from './deploy.js';
import { setPassword } from './set-password.js';
import { readHidden } from './tty-prompt.js';

const USAGE = [
  '用法：',
  '  vesper set-password',
  '  vesper deploy [--origin https://域名]... [--dir 安装目录] [--start] [--no-task]',
  '  vesper undeploy [--dir 安装目录]',
  '',
].join('\n');

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'set-password' && rest.length === 0) {
    const result = await setPassword(webDatabasePath(vesperHome()), (prompt) => readHidden(prompt));
    (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === 'deploy') {
    process.stdout.write(`${await deploy(parseDeployArgs(rest))}\n`);
    return 0;
  }
  if (command === 'undeploy' && (rest.length === 0 || (rest.length === 2 && rest[0] === '--dir'))) {
    process.stdout.write(`${await undeploy(rest[1])}\n`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
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
