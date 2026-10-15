import { describe, expect, test } from 'vitest';
import { buildEnv, shellLaunchSpec } from '../src/shells.js';

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

describe('shellLaunchSpec', () => {
  const paths = { systemRoot: 'C:\\Windows', gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' };

  test('starts Windows PowerShell with a UTF-8 bootstrap passed inline', () => {
    const spec = shellLaunchSpec('powershell', paths);
    expect(spec.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spec.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
    const script = decodePowerShellCommand(spec.args[3] ?? '');
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
    expect(script).toContain('[Console]::InputEncoding');
  });

  test('starts cmd with the UTF-8 code page', () => {
    const spec = shellLaunchSpec('cmd', paths);
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spec.args).toEqual(['/K', 'chcp 65001>nul']);
  });

  test('starts Git Bash as a login shell in the session directory with the UTF-8 code page', () => {
    const spec = shellLaunchSpec('gitbash', paths);
    expect(spec.file).toBe(paths.gitBash);
    expect(spec.args).toEqual(['-c', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i']);
    expect(spec.env).toEqual({ CHERE_INVOKING: '1' });
  });
});

describe('buildEnv', () => {
  test('lets overrides replace variables regardless of name casing', () => {
    const env = buildEnv({ Path: 'C:\\old', TEMP: 'C:\\tmp' }, { PATH: 'C:\\new' });
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['Path']);
    expect(env['Path']).toBe('C:\\new');
    expect(env['TEMP']).toBe('C:\\tmp');
  });

  test('collapses duplicate names in the base environment', () => {
    const env = buildEnv({ Path: 'C:\\a', PATH: 'C:\\b' }, {});
    expect(Object.keys(env)).toEqual(['Path']);
    expect(env['Path']).toBe('C:\\b');
  });

  test('drops undefined values', () => {
    expect(buildEnv({ A: undefined, B: '1' }, {})).toEqual({ B: '1' });
  });
});
