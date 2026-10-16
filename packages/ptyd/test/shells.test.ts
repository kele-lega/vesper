import { describe, expect, test } from 'vitest';
import { buildEnv, commandLaunchSpec, gitRootOf, msysToWindowsPath, quoteArgument, shellLaunchSpec } from '../src/shells.js';

describe('commandLaunchSpec', () => {
  test('starts an executable with its arguments quoted for CommandLineToArgvW', () => {
    const spec = commandLaunchSpec({ file: 'C:\\Program Files\\Claude\\claude.exe', args: ['--model', 'opus 4'], env: { A: '1' }, label: 'Claude' }, 'C:\\Windows');
    expect(spec).toEqual({ file: 'C:\\Program Files\\Claude\\claude.exe', args: '--model "opus 4"', env: { A: '1' } });
  });

  test('passes no arguments as an empty list, so node-pty still quotes a path with spaces', () => {
    expect(commandLaunchSpec({ file: 'C:\\Program Files\\x.exe', args: [], label: 'x' }, 'C:\\Windows').args).toEqual([]);
  });

  test('runs a command line through cmd.exe, which keeps everything between the outer quotes', () => {
    const spec = commandLaunchSpec({ commandLine: 'npm run dev && echo "done"', label: 'dev' }, 'C:\\Windows');
    expect(spec).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: '/d /s /c "npm run dev && echo "done""', env: {} });
  });

  test.each([
    ['plain', 'plain'],
    ['', '""'],
    ['two words', '"two words"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['"', '"\\""'],
    ['C:\\dir with space\\', '"C:\\dir with space\\\\"'],
    ['a\\\\"b', '"a\\\\\\\\\\"b"'],
    ['C:\\no\\spaces\\', 'C:\\no\\spaces\\'],
  ])('quoteArgument(%j) is %j', (arg, quoted) => {
    expect(quoteArgument(arg)).toBe(quoted);
  });
});

const decodePowerShellCommand = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');

describe('shellLaunchSpec', () => {
  const paths = { systemRoot: 'C:\\Windows', gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' };

  test('starts Windows PowerShell with a UTF-8 bootstrap passed inline', () => {
    const spec = shellLaunchSpec('powershell', paths, { cwdNonce: 'n' });
    expect(spec.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spec.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
    const script = decodePowerShellCommand(spec.args[3] ?? '');
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
    expect(script).toContain('[Console]::InputEncoding');
  });

  test('starts cmd with the UTF-8 code page', () => {
    const spec = shellLaunchSpec('cmd', paths, { cwdNonce: 'n' });
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spec.args).toEqual(['/K', 'chcp 65001>nul']);
    expect(Object.keys(spec.env)).toEqual(['PROMPT']);
  });

  test('starts Git Bash as a login shell in the session directory with the UTF-8 code page', () => {
    const spec = shellLaunchSpec('gitbash', paths, { cwdNonce: 'n' });
    expect(spec.file).toBe(paths.gitBash);
    expect(spec.args).toEqual(['-c', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i']);
    expect(spec.env['CHERE_INVOKING']).toBe('1');
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

describe('current directory reporting', () => {
  const paths = { systemRoot: 'C:\\Windows', gitBash: 'C:\\Program Files\\Git\\bin\\bash.exe' };
  const cwdNonce = 'n0nce_-X';
  const bashCommand = 'printf "\\033]7690;cwd;n0nce_-X;%s\\007" "$PWD"';

  test('PowerShell wraps the existing prompt and reports file system locations with the nonce', () => {
    const script = decodePowerShellCommand(shellLaunchSpec('powershell', paths, { cwdNonce, inherited: {} }).args[3] ?? '');
    expect(script).toContain('$global:__VesperPrompt = if (Test-Path Function:\\prompt)');
    expect(script).toContain('$text = & $global:__VesperPrompt');
    expect(script).toContain('[Console]::Write("$([char]27)]7690;cwd;n0nce_-X;$($here.ProviderPath)$([char]7)")');
  });

  test('cmd puts the report in front of the inherited prompt, or the default one', () => {
    expect(shellLaunchSpec('cmd', paths, { cwdNonce, inherited: {} }).env).toEqual({ PROMPT: '$e]7690;cwd;n0nce_-X;$P$e\\$P$G' });
    expect(shellLaunchSpec('cmd', paths, { cwdNonce, inherited: { prompt: '$T $G' } }).env).toEqual({
      PROMPT: '$e]7690;cwd;n0nce_-X;$P$e\\$T $G',
    });
  });

  test('Git Bash runs the report before any inherited PROMPT_COMMAND', () => {
    expect(shellLaunchSpec('gitbash', paths, { cwdNonce, inherited: {} }).env).toEqual({ CHERE_INVOKING: '1', PROMPT_COMMAND: bashCommand });
    const chained = shellLaunchSpec('gitbash', paths, { cwdNonce, inherited: { PROMPT_COMMAND: 'history -a' } }).env;
    expect(chained['PROMPT_COMMAND']).toBe(`${bashCommand}; history -a`);
  });

  test('refuses a nonce that could break out of the shell quoting', () => {
    expect(() => shellLaunchSpec('cmd', paths, { cwdNonce: 'a" & del x' })).toThrow(/base64url/);
  });
});

describe('MSYS paths', () => {
  const root = 'C:\\Program Files\\Git';
  const temp = 'C:\\Users\\me\\AppData\\Local\\Temp';

  test.each([
    ['/c/Users/me', 'C:\\Users\\me'],
    ['/d', 'D:\\'],
    ['/d/代码 项目', 'D:\\代码 项目'],
    ['/usr/bin', 'C:\\Program Files\\Git\\usr\\bin'],
    ['/', 'C:\\Program Files\\Git'],
    ['/tmp', temp],
    ['/tmp/x', `${temp}\\x`],
    ['//server/share/dir', '\\\\server\\share\\dir'],
    ['C:/already', 'C:\\already'],
    ['relative', 'relative'],
  ])('%s becomes %s', (path, expected) => {
    expect(msysToWindowsPath(path, root, temp)).toBe(expected);
  });

  test.each([
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git'],
    ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git'],
  ])('finds the Git root of %s', (bash, root) => {
    expect(gitRootOf(bash)).toBe(root);
  });
});
