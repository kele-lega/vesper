import { describe, expect, test } from 'vitest';
import { injectAgent, readHook, readTitle } from '../src/agent-inject.js';

const options = { hookUrl: 'http://127.0.0.1:5000/hook/t', resumeId: null, systemRoot: 'C:\\Windows', scratchFile: 'C:\\tmp\\g.json', platform: 'win32' as const };
const claude = { file: 'C:\\claude.exe', args: ['--verbose'], label: 'Claude' };

describe('injectAgent', () => {
  test('Claude gets inline hook settings and a session id chosen in advance, or resumes one', () => {
    const first = injectAgent(claude, 'claude', options);
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const args = 'args' in first.command ? first.command.args : [];
    expect(args.slice(0, 2)).toEqual(['--verbose', '--settings']);
    const settings = JSON.parse(args[2]!) as { hooks: Record<string, [{ hooks: [{ url: string }] }]> };
    expect(settings.hooks['Stop']![0].hooks[0].url).toBe(options.hookUrl);
    expect(args.slice(3)).toEqual(['--session-id', first.sessionId]);
    const again = injectAgent(claude, 'claude', { ...options, resumeId: 'abc' });
    expect('args' in again.command && again.command.args.slice(-2)).toEqual(['--resume', 'abc']);
  });

  test('Codex posts its notifications with curl and resumes by id; a command line gets quoted arguments', () => {
    const codex = injectAgent({ commandLine: '"C:\\npm\\codex.cmd"', label: 'Codex' }, 'codex', { ...options, resumeId: 't1' });
    const line = 'commandLine' in codex.command ? codex.command.commandLine : '';
    expect(line).toContain('C:/Windows/System32/curl.exe');
    expect(line).toMatch(/ resume t1$/);
    expect(codex.sessionId).toBe('t1');
  });

  test('Gemini reads its hooks from a defaults file named in its environment', () => {
    const gemini = injectAgent({ commandLine: 'gemini', label: 'Gemini' }, 'gemini', options);
    expect(gemini.command.env).toMatchObject({ GEMINI_CLI_NO_RELAUNCH: 'true', GEMINI_CLI_SYSTEM_DEFAULTS_PATH: options.scratchFile });
    expect(JSON.parse(gemini.file!.content)).toMatchObject({ general: { enableAutoUpdate: false }, hooks: { AfterAgent: expect.any(Array) } });
  });
});

describe('readHook and readTitle', () => {
  test.each([
    [{ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { signal: 'working', sessionId: 's' }],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { signal: 'working' }],
    [{ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, { signal: 'waiting' }],
    [{ hook_event_name: 'PermissionRequest' }, { signal: 'waiting' }],
    [{ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, {}],
    [{ hook_event_name: 'Stop' }, { signal: 'done' }],
    [{ hook_event_name: 'SessionStart', session_id: 's2' }, { sessionId: 's2' }],
    ['not an object', {}],
  ])('claude %j', (payload, reading) => {
    expect(readHook('claude', payload)).toEqual(reading);
  });

  test('codex turn-complete and gemini permission', () => {
    expect(readHook('codex', { type: 'agent-turn-complete', 'thread-id': 'th' })).toEqual({ signal: 'done', sessionId: 'th' });
    expect(readHook('gemini', { hook_event_name: 'Notification', notification_type: 'ToolPermission' })).toEqual({ signal: 'waiting' });
  });

  test('title glyphs', () => {
    expect(readTitle('claude', '\u{25d0} Claude Code')).toBe('working');
    expect(readTitle('claude', '\u{2733} Claude Code')).toBe('idle');
    expect(readTitle('codex', '\u{2827} codex')).toBe('working');
    expect(readTitle('gemini', '\u{270b} Action Required')).toBe('waiting');
    expect(readTitle('gemini', 'plain')).toBeUndefined();
  });
});
