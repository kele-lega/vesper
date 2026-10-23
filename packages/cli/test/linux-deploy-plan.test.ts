import { posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildLinuxPlan, linuxUnit, UNIT_NAME } from '../src/linux-deploy-plan.js';
import { parseDeployArgs } from '../src/deploy.js';

const input = {
  userHome: '/home/alice',
  home: '/home/alice/.local/share/vesper',
  node: '/home/alice/.local/bin/node',
  sourceRoot: '/home/alice/src/vesper',
  env: { PATH: '/home/alice/.local/bin:/usr/bin:/bin' },
};

describe('Linux user deployment plan', () => {
  test('keeps install, data and the user unit separate and saves the deployment PATH', () => {
    const plan = buildLinuxPlan(input, posix);
    expect(plan.installDir).toBe('/home/alice/.local/lib/vesper');
    expect(plan.home).toBe(input.home);
    expect(plan.logFile).toBe(`${input.home}/logs/web.log`);
    expect(plan.unitFile).toBe(`/home/alice/.config/systemd/user/${UNIT_NAME}`);
    const unit = linuxUnit(plan, ['https://vesper.example.com']);
    expect(unit).toContain('KillMode=process\n');
    expect(unit).toContain('WantedBy=default.target\n');
    expect(unit).toContain('Environment="PATH=/home/alice/.local/bin:/usr/bin:/bin"');
    expect(unit).toContain(`Environment="VESPER_HOME=${input.home}"`);
    expect(unit).toContain(`Environment="VESPER_LOG_FILE=${input.home}/logs/web.log"`);
    expect(unit).not.toMatch(/\n(?:User|Group|ExecStop)=/);
  });

  test('uses XDG config and the ptyd-selected home, never inventing a second home', () => {
    const plan = buildLinuxPlan({ ...input, home: '/home/alice/data/vesper', env: { ...input.env, XDG_CONFIG_HOME: '/home/alice/config' } }, posix);
    expect(plan.unitFile).toBe('/home/alice/config/systemd/user/vesper.service');
    expect(plan.home).toBe('/home/alice/data/vesper');
  });

  test('escapes quotes, backslashes, percent specifiers and dollar expansion without a shell', () => {
    const plan = buildLinuxPlan({
      ...input,
      dir: '/home/alice/apps/"Vesper" %n ${HOME}',
      env: { PATH: '/home/alice/a"b\\c/%n/$HOME:/usr/bin' },
    }, posix);
    const unit = linuxUnit(plan, ['https://vesper.example.com']);
    expect(unit).toContain('ExecStart=:"/home/alice/.local/bin/node" "/home/alice/apps/\\"Vesper\\" %%n ${HOME}/node_modules/@vesper/web/dist/main.js"');
    // WorkingDirectory is a literal path, not a quoted command argument.
    expect(unit).toContain('WorkingDirectory=/home/alice/apps/"Vesper" %%n ${HOME}\n');
    expect(unit).toContain('Environment="PATH=/home/alice/a\\"b\\\\c/%%n/$HOME:/usr/bin"');
    expect(unit).not.toContain('/bin/sh');
  });

  test('rejects relative, control-character, traversal and overlapping deletion targets', () => {
    for (const dir of ['', 'relative', '~/.local/lib/vesper', '/', '/home/alice', input.home, `${input.home}/runtime`, '/home/alice/.local/share', input.sourceRoot, '/home/alice/src', '/home/alice/a/../b', '/home/alice/a\nb', '/home/alice/a\\b', '/home/alice/a ']) {
      expect(() => buildLinuxPlan({ ...input, dir }, posix), dir).toThrow();
    }
    for (const home of ['relative', '/', '/home/alice', '/home/alice/.local/lib/vesper/data']) {
      expect(() => buildLinuxPlan({ ...input, home }, posix), home).toThrow();
    }
    expect(() => buildLinuxPlan({ ...input, env: { PATH: '/usr/bin\nExecStart=/bad' } }, posix)).toThrow();
    expect(() => buildLinuxPlan({ ...input, env: { PATH: '/usr/bin', XDG_CONFIG_HOME: 'relative' } }, posix)).toThrow();
    expect(() => linuxUnit(buildLinuxPlan(input, posix), ['https://a.b\nExecStart=/bad'])).toThrow();
  });

  test('requires an explicit start flag and refuses missing argument values', () => {
    expect(parseDeployArgs([])).toMatchObject({ start: false, noTask: false });
    expect(parseDeployArgs(['--start'])).toMatchObject({ start: true });
    expect(() => parseDeployArgs(['--dir'])).toThrow();
    expect(() => parseDeployArgs(['--dir', '--start'])).toThrow();
    expect(() => parseDeployArgs(['--origin'])).toThrow();
  });
});
