import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { injectAgent } from '../src/agent-inject.js';
import { localDirectory } from '../src/hosted-session.js';
import { hostPaths, vesperHome } from '../src/paths.js';
import { buildEnvFor, commandLaunchSpec, quotePosixArgument, shellLaunchSpec } from '../src/shells.js';
import { parseProcStat } from '../src/unix-processes.js';

const paths = { systemRoot: 'C:\\Windows', gitBash: 'C:\\Git\\bin\\bash.exe' };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function integrationDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-unix-shell-'));
  dirs.push(dir);
  return dir;
}

describe('Unix launch specs', () => {
  test('preserves executable argv and uses /bin/sh only for command lines', () => {
    const args = ['two words', '$(touch /tmp/not-run)', "a'b", ''];
    const command = { file: '/usr/bin/agent', args, label: 'Agent' };
    expect(commandLaunchSpec(command, '', 'linux')).toEqual({ file: command.file, args, env: {} });
    expect(commandLaunchSpec({ commandLine: 'printf "%s" "$HOME"', label: 'demo' }, '', 'linux'))
      .toEqual({ file: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'], env: {} });
    expect(quotePosixArgument("a'b $HOME")).toBe("'a'\\''b $HOME'");
  });

  test('keeps Unix environment names case-sensitive', () => {
    expect(buildEnvFor('linux', { PATH: '/usr/bin', Path: 'separate', A: undefined }, { PATH: '/bin' }))
      .toEqual({ PATH: '/bin', Path: 'separate' });
  });

  test('bash sources login configuration before extending string or array prompt hooks', () => {
    const dir = integrationDir();
    const spec = shellLaunchSpec('bash', paths, { cwdNonce: 'secret_nonce', integrationDir: dir });
    expect(spec.file).toBe('bash');
    expect(spec.args).toEqual(['--rcfile', join(dir, 'bashrc'), '-i']);
    expect(spec.env).toEqual({ VESPER_CWD_NONCE: 'secret_nonce' });
    const script = readFileSync(join(dir, 'bashrc'), 'utf8');
    expect(script.indexOf('unset VESPER_CWD_NONCE')).toBeLessThan(script.indexOf('. /etc/profile'));
    expect(script).toContain('.bash_profile');
    expect(script).toContain('PROMPT_COMMAND+=');
    expect(script).toContain('7690;cwd;%s;%s');
    expect(script).not.toContain('secret_nonce');
  });

  test('zsh forwards startup configuration and restores the original ZDOTDIR', () => {
    const dir = integrationDir();
    const spec = shellLaunchSpec('zsh', paths, { cwdNonce: 'secret_nonce', integrationDir: dir, inherited: { ZDOTDIR: '/my config' } });
    expect(spec.args).toEqual(['-i']);
    expect(spec.env).toMatchObject({ ZDOTDIR: dir, VESPER_USER_ZDOTDIR: '/my config', VESPER_ZDOTDIR_SET: '1' });
    expect(readFileSync(join(dir, '.zshenv'), 'utf8')).toContain('unset VESPER_CWD_NONCE');
    expect(readFileSync(join(dir, '.zshrc'), 'utf8')).toContain('add-zsh-hook precmd __vesper_report_cwd');
  });

  test('fish extends its prompt event and sh has no injected cwd hook', () => {
    const fish = shellLaunchSpec('fish', paths, { cwdNonce: 'secret_nonce' });
    expect(fish.args[1]).toBe('--init-command');
    expect(fish.args[2]).toContain('--on-event fish_prompt');
    expect(fish.args[2]).toContain('set -e VESPER_CWD_NONCE');
    expect(fish.args[2]).not.toContain('secret_nonce');
    expect(shellLaunchSpec('sh', paths, { cwdNonce: 'secret_nonce' })).toEqual({ file: '/bin/sh', args: ['-i'], env: {} });
  });

  test('resumes agents even when the hook receiver is unavailable', () => {
    for (const kind of ['claude', 'gemini', 'codex'] as const) {
      const result = injectAgent({ file: '/usr/bin/agent', args: [], label: kind }, kind, {
        resumeId: 'previous', systemRoot: '', scratchFile: '/unused', platform: 'linux',
      });
      expect(result).toEqual({ command: { file: '/usr/bin/agent', args: [kind === 'codex' ? 'resume' : '--resume', 'previous'], label: kind }, sessionId: 'previous' });
    }
  });

  test('agent command-line injection quotes JSON for POSIX shells, not cmd.exe', () => {
    const options = { hookUrl: 'http://127.0.0.1:5000/hook/t', resumeId: null, systemRoot: '', scratchFile: '/tmp/g.json', platform: 'linux' as const };
    const codex = injectAgent({ commandLine: 'codex', label: 'Codex' }, 'codex', options);
    expect('commandLine' in codex.command && codex.command.commandLine).toContain("'notify=[\"curl\"");
    const gemini = injectAgent({ file: '/usr/bin/gemini', args: [], label: 'Gemini' }, 'gemini', options);
    expect(JSON.parse(gemini.file!.content).hooks.AfterAgent[0].hooks[0].command).toContain("'curl'");
  });
});

describe('Unix metadata', () => {
  test('selects XDG home and a home-local socket independently of Windows named pipes', () => {
    expect(vesperHome({ XDG_DATA_HOME: '/data' }, 'linux')).toBe(join('/data', 'vesper'));
    expect(hostPaths('/home/me/vesper', 'linux').pipe).toBe(join('/home/me/vesper', 'run', 'ptyd.sock'));
    expect(() => hostPaths('/' + 'x'.repeat(110), 'linux')).toThrow(/too long/);
  });

  test('accepts only plain absolute local cwd paths on each platform', () => {
    expect(localDirectory('/home/me/project', 'linux')).toBe('/home/me/project');
    for (const path of ['relative', '//server/share', '/bad\u{000a}path', 'C:\\work']) {
      expect(localDirectory(path, 'linux')).toBeUndefined();
    }
    expect(localDirectory('/not-a-windows-path', 'win32')).toBeUndefined();
  });

  test('reads process session/start identities even when comm contains spaces and parentheses', () => {
    const fields = ['S', '1', '321', '321', ...Array<string>(15).fill('0'), '987654', '0'];
    expect(parseProcStat(`321 (strange ) process) ${fields.join(' ')}`)).toEqual({ pid: 321, ppid: 1, group: 321, session: 321, start: '987654' });
    expect(parseProcStat('malformed')).toBeUndefined();
  });
});
