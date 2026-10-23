import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { deployLinux, undeployLinux, type LinuxDependencies } from '../src/linux-deploy.js';
import { MARKER } from '../src/deploy-plan.js';
import { UNIT_NAME } from '../src/linux-deploy-plan.js';
import * as linuxFiles from '../src/linux-files.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vesper-linux-deploy-'));
  dirs.push(root);
  const userHome = join(root, 'user');
  mkdirSync(userHome);
  const deps: LinuxDependencies = {
    userHome, home: join(userHome, '.local', 'share', 'vesper'), node: process.execPath,
    sourceRoot: join(root, 'source'), env: { PATH: process.env['PATH'] ?? '/usr/bin' }, uid: 1000,
    systemctl: vi.fn((args: readonly string[]) => args[0] === 'show' ? 'inactive\n' : ''),
    running: vi.fn(async () => false),
    copy: vi.fn((stage: string) => { writeFileSync(join(stage, 'runtime.txt'), 'runtime'); return ['@vesper/web']; }),
  };
  const install = join(userHome, '.local', 'lib', 'vesper');
  const unit = join(userHome, '.config', 'systemd', 'user', UNIT_NAME);
  const options = { origins: ['https://vesper.example.com'], noTask: false, start: false };
  return { root, deps, install, unit, options };
}

describe('Linux user deploy/undeploy lifecycle (mock systemctl on every platform)', () => {
  test('installs and enables, never implicitly starts or invokes privileged commands', async () => {
    const { deps, install, unit, options } = fixture();
    const result = await deployLinux(options, deps);
    expect(result).toContain('尚未启动');
    expect(existsSync(join(install, MARKER))).toBe(true);
    expect(readFileSync(unit, 'utf8')).toContain('KillMode=process');
    expect(vi.mocked(deps.systemctl).mock.calls).toEqual([
      [['show-environment']], [['show', UNIT_NAME, '--property=ActiveState', '--value']],
      [['daemon-reload']], [['enable', UNIT_NAME]],
    ]);
    expect(deps.running).toHaveBeenCalledWith(deps.home);
  });

  test('starts only when --start was explicitly requested', async () => {
    const { deps, options } = fixture();
    await deployLinux({ ...options, start: true }, deps);
    expect(deps.systemctl).toHaveBeenLastCalledWith(['start', UNIT_NAME]);
  });

  test('removes only its unit and runtime, leaving sessions, logs and data intact', async () => {
    const { deps, install, unit, options } = fixture();
    await deployLinux(options, deps);
    const data = join(deps.home, 'session.data');
    writeFileSync(data, 'keep me');
    vi.mocked(deps.systemctl).mockClear();
    await undeployLinux(undefined, deps);
    expect(existsSync(install)).toBe(false);
    expect(existsSync(unit)).toBe(false);
    expect(readFileSync(data, 'utf8')).toBe('keep me');
    expect(vi.mocked(deps.systemctl).mock.calls).toEqual([
      [['show-environment']], [['show', UNIT_NAME, '--property=ActiveState', '--value']],
      [['disable', UNIT_NAME]], [['daemon-reload']],
    ]);
  });

  test('refuses a live web/ptyd on both install and uninstall without modifying files', async () => {
    const { deps, install, options } = fixture();
    vi.mocked(deps.running).mockResolvedValue(true);
    await expect(deployLinux(options, deps)).rejects.toThrow(/正在运行/);
    expect(existsSync(install)).toBe(false);
    expect(deps.copy).not.toHaveBeenCalled();
    vi.mocked(deps.running).mockResolvedValue(false);
    await deployLinux(options, deps);
    vi.mocked(deps.running).mockResolvedValue(true);
    await expect(undeployLinux(undefined, deps)).rejects.toThrow(/正在运行/);
    expect(existsSync(join(install, 'runtime.txt'))).toBe(true);
    expect(deps.systemctl).not.toHaveBeenCalledWith(['disable', UNIT_NAME]);
  });

  test('also checks the recorded data home if the invoking environment changed', async () => {
    const { deps, install, options } = fixture();
    await deployLinux(options, deps);
    const changed = { ...deps, home: join(deps.userHome, 'different-data') };
    vi.mocked(deps.running).mockImplementation(async (home) => home === deps.home);
    await expect(undeployLinux(undefined, changed)).rejects.toThrow(/正在运行/);
    expect(existsSync(install)).toBe(true);
  });

  test('fails closed for an active or activating unit, even if no port answers yet', async () => {
    const { deps, install, options } = fixture();
    await deployLinux(options, deps);
    for (const state of ['active', 'activating', 'deactivating', '']) {
      vi.mocked(deps.systemctl).mockImplementation((args) => args[0] === 'show' ? state : '');
      await expect(deployLinux(options, deps)).rejects.toThrow(/尚未停止/);
      await expect(undeployLinux(undefined, deps)).rejects.toThrow(/尚未停止/);
    }
    expect(existsSync(install)).toBe(true);
  });

  test('refuses root, unavailable user manager, no-task and unrelated target/unit before copying', async () => {
    const { deps, install, unit, options } = fixture();
    await expect(deployLinux(options, { ...deps, uid: 0 })).rejects.toThrow(/普通用户/);
    await expect(deployLinux({ ...options, noTask: true }, deps)).rejects.toThrow(/仅用于 Windows/);
    vi.mocked(deps.systemctl).mockImplementation(() => { throw new Error('no user bus'); });
    await expect(deployLinux(options, deps)).rejects.toThrow('no user bus');
    expect(deps.copy).not.toHaveBeenCalled();
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, 'unrelated'), 'keep');
    await expect(deployLinux(options, deps)).rejects.toThrow(/不会覆盖/);
    rmSync(install, { recursive: true });
    mkdirSync(join(deps.userHome, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unit, '[Service]\nExecStart=/some/other/program\n');
    await expect(deployLinux(options, deps)).rejects.toThrow(/不属于此安装/);
    await expect(undeployLinux(undefined, deps)).rejects.toThrow(/不属于此安装/);
    expect(readFileSync(unit, 'utf8')).toContain('/some/other/program');
  });

  test('refuses symlinked deployment/log directories and hard-linked log files', async () => {
    const { deps, install, root, options } = fixture();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(deps.userHome, '.local', 'lib'), { recursive: true });
    symlinkSync(elsewhere, install, 'junction');
    await expect(deployLinux(options, deps)).rejects.toThrow(/链接/);
    rmSync(install);
    mkdirSync(deps.home, { recursive: true });
    symlinkSync(elsewhere, join(deps.home, 'logs'), 'junction');
    await expect(deployLinux(options, deps)).rejects.toThrow(/链接/);
    rmSync(join(deps.home, 'logs'));
    mkdirSync(join(deps.home, 'logs'));
    const file = join(root, 'keep.txt');
    writeFileSync(file, 'keep');
    linkSync(file, join(deps.home, 'logs', 'web.log'));
    await expect(deployLinux(options, deps)).rejects.toThrow(/链接/);
    expect(readFileSync(file, 'utf8')).toBe('keep');
  });

  test.runIf(process.platform === 'linux')('requires an existing trusted child below a root-owned sticky directory', () => {
    const { root } = fixture();
    expect(() => linuxFiles.assertSafePath(join(root, 'new-parent', 'runtime'), 'directory')).not.toThrow();
    expect(() => linuxFiles.assertSafePath(join(root, 'new-parent', 'runtime'), 'directory', true)).toThrow(/父目录/);
    expect(() => linuxFiles.assertSafePath(`${root}-absent/runtime`, 'directory')).toThrow(/共享父目录/);
  });

  test('preserves an unrelated install directory created while checking runtime', async () => {
    const { deps, install, unit, options } = fixture();
    const unrelated = join(install, 'unrelated');
    vi.mocked(deps.running).mockImplementationOnce(async () => {
      mkdirSync(install, { recursive: true });
      writeFileSync(unrelated, 'keep');
      return false;
    });
    await expect(deployLinux(options, deps)).rejects.toThrow(/不会覆盖/);
    expect(deps.copy).not.toHaveBeenCalled();
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
    expect(existsSync(unit)).toBe(false);
  });

  test('refuses an install parent replaced by a link while checking runtime', async () => {
    const { deps, root, unit, options } = fixture();
    const elsewhere = join(root, 'elsewhere');
    const unrelated = join(elsewhere, 'vesper', 'unrelated');
    mkdirSync(join(elsewhere, 'vesper'), { recursive: true });
    writeFileSync(unrelated, 'keep');
    mkdirSync(join(deps.userHome, '.local'));
    vi.mocked(deps.running).mockImplementationOnce(async () => {
      symlinkSync(elsewhere, join(deps.userHome, '.local', 'lib'), 'junction');
      return false;
    });
    await expect(deployLinux(options, deps)).rejects.toThrow(/链接/);
    expect(deps.copy).not.toHaveBeenCalled();
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
    expect(existsSync(unit)).toBe(false);
  });

  test('rechecks an install target after staging before deleting anything', async () => {
    const { deps, install, unit, options } = fixture();
    const unrelated = join(install, 'unrelated');
    vi.mocked(deps.copy).mockImplementation((stage) => {
      mkdirSync(install);
      writeFileSync(unrelated, 'keep');
      writeFileSync(join(stage, 'runtime.txt'), 'runtime');
      return ['@vesper/web'];
    });
    await expect(deployLinux(options, deps)).rejects.toThrow(/不会覆盖/);
    expect(readFileSync(unrelated, 'utf8')).toBe('keep');
    expect(existsSync(unit)).toBe(false);
  });

  test('refuses uninstall if the installed marker disappears while checking runtime', async () => {
    const { deps, install, unit, options } = fixture();
    await deployLinux(options, deps);
    vi.mocked(deps.systemctl).mockClear();
    vi.mocked(deps.running).mockImplementationOnce(async () => {
      rmSync(join(install, MARKER));
      writeFileSync(join(install, 'unrelated'), 'keep');
      return false;
    });
    await expect(undeployLinux(undefined, deps)).rejects.toThrow(/标记/);
    expect(readFileSync(join(install, 'unrelated'), 'utf8')).toBe('keep');
    expect(existsSync(unit)).toBe(true);
    expect(deps.systemctl).not.toHaveBeenCalledWith(['disable', UNIT_NAME]);
  });

  test('does not validate or remove the staging path after it was renamed', async () => {
    const { deps, options } = fixture();
    const check = vi.spyOn(linuxFiles, 'assertSafePath');
    try {
      await deployLinux(options, deps);
      expect(check.mock.calls.some(([file]) => file.includes('.vesper-install-'))).toBe(false);
    } finally {
      check.mockRestore();
    }
  });

  test('copies into a stage first and preserves an existing install when copy fails', async () => {
    const { deps, install, options } = fixture();
    await deployLinux(options, deps);
    vi.mocked(deps.copy).mockImplementation(() => { throw new Error('missing build'); });
    await expect(deployLinux(options, deps)).rejects.toThrow('missing build');
    expect(readFileSync(join(install, 'runtime.txt'), 'utf8')).toBe('runtime');
  });
});
