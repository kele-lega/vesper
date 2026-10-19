import { describe, expect, test } from 'vitest';
import {
  HOST_PROTOCOL_VERSION as V,
  HostApiError,
  parseControlMessage,
  parseControlRequest,
  parseCreateOptions,
  parseChallenge,
  parseHello,
  parseHelloReply,
  parseProof,
  parseSessionId,
  parseSize,
} from '../src/host-api.js';

const nonce = 'AbCdEfGhIjKlMnOpQrStUv';

describe('parseHello', () => {
  test('accepts a control hello', () => {
    expect(parseHello({ v: V, nonce, role: 'control' })).toEqual({ v: V, nonce, role: 'control' });
  });

  test('accepts an attach hello with resume point and size', () => {
    const hello = { v: V, nonce, role: 'attach', session: 'abc_-1', resume: { inc: 2, seq: 99 }, size: { cols: 80, rows: 24 } };
    expect(parseHello(hello)).toEqual(hello);
  });

  test('drops unknown fields, including a token sent by an older client', () => {
    expect(parseHello({ v: V, nonce, role: 'control', token: 'x', extra: 1 })).toEqual({ v: V, nonce, role: 'control' });
  });

  test('reports a version mismatch with its own code', () => {
    expect(() => parseHello({ v: V + 1, nonce, role: 'control' })).toThrow(
      expect.objectContaining({ code: 'version_mismatch' }),
    );
  });

  test.each([
    ['a non-object', 'hello'],
    ['a missing version', { nonce, role: 'control' }],
    ['a short nonce', { v: V, nonce: 'abc', role: 'control' }],
    ['a nonce with other characters', { v: V, nonce: `${nonce}!`, role: 'control' }],
    ['an unknown role', { v: V, nonce, role: 'admin' }],
    ['a bad session id', { v: V, nonce, role: 'attach', session: '../x' }],
    ['a negative seq', { v: V, nonce, role: 'attach', session: 'a', resume: { inc: 0, seq: -1 } }],
    ['a zero size', { v: V, nonce, role: 'attach', session: 'a', size: { cols: 0, rows: 1 } }],
  ])('rejects %s', (_name, hello) => {
    expect(() => parseHello(hello)).toThrow(HostApiError);
  });
});

describe('handshake messages', () => {
  test('parse a challenge and a proof', () => {
    expect(parseChallenge({ proof: nonce, nonce, extra: 1 })).toEqual({ proof: nonce, nonce });
    expect(parseProof({ proof: nonce })).toEqual({ proof: nonce });
  });

  test.each([{ proof: nonce }, { nonce }, { proof: 'short', nonce }, 'x'])('rejects the challenge %j', (value) => {
    expect(() => parseChallenge(value)).toThrow(HostApiError);
  });

  test('rejects a proof that is missing or malformed', () => {
    expect(() => parseProof({})).toThrow(HostApiError);
    expect(() => parseProof({ proof: 'a b' })).toThrow(HostApiError);
  });
});

describe('parseControlRequest', () => {
  test.each([
    { id: 1, op: 'ping' },
    { id: 2, op: 'list' },
    { id: 3, op: 'shutdown' },
    { id: 4, op: 'kill', session: 's1' },
    { id: 5, op: 'remove', session: 's1' },
    { id: 6, op: 'create', shell: 'cmd', cwd: 'D:\\code', cols: 100, rows: 30, title: '构建', elevation: 'admin' },
    { id: 7, op: 'create', shell: 'gitbash', elevation: 'normal' },
    { id: 8, op: 'restart', session: 's1' },
    {
      id: 9,
      op: 'create',
      command: { file: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: ['--model', 'opus'], env: { 'ProgramFiles(x86)': 'x', A_B: '' }, label: 'Claude' },
      cwd: 'D:\\code',
      elevation: 'normal',
    },
    { id: 10, op: 'create', command: { commandLine: 'npm run dev && echo "done"', label: '开发服务器' }, elevation: 'admin' },
  ])('accepts $op', (request) => {
    expect(parseControlRequest(request)).toEqual(request);
  });

  test('a command without args gets an empty list', () => {
    expect(parseCreateOptions({ command: { file: 'C:\\a.exe', label: 'A' }, elevation: 'admin' })).toEqual({
      command: { file: 'C:\\a.exe', args: [], label: 'A' },
      elevation: 'admin',
    });
  });

  test('resumeId continues an agent command and is refused for a shell or a bad id', () => {
    const command = { file: 'C:\\a.exe', label: 'A', agent: 'claude' };
    expect(parseCreateOptions({ command, elevation: 'normal', resumeId: 'abc-123' })).toMatchObject({ resumeId: 'abc-123' });
    expect(() => parseCreateOptions({ shell: 'cmd', elevation: 'normal', resumeId: 'abc' })).toThrow(/resumeId/);
    expect(() => parseCreateOptions({ command, elevation: 'normal', resumeId: '../x' })).toThrow(/resumeId/);
    expect(() => parseCreateOptions({ command, elevation: 'normal', resumeId: '--dangerously-skip-permissions' })).toThrow(/resumeId/);
    expect(() => parseCreateOptions({ command, elevation: 'normal', resumeId: 7 })).toThrow(/resumeId/);
  });

  test('create needs an explicit elevation: leaving it out never means admin', () => {
    expect(() => parseCreateOptions({ shell: 'cmd' })).toThrow(/elevation/);
    expect(() => parseCreateOptions({ shell: 'cmd', elevation: 'root' })).toThrow(/elevation/);
  });

  test('rejects a request without an id', () => {
    expect(() => parseControlRequest({ op: 'list' })).toThrow(/numeric id/);
  });

  test('keeps the request id on validation errors so the host can answer', () => {
    expect(() => parseControlRequest({ id: 9, op: 'nope' })).toThrow(expect.objectContaining({ requestId: 9 }));
  });

  test.each([
    { shell: 'bash' },
    { shell: 'cmd', cwd: '' },
    { shell: 'cmd', cwd: 'C:\\a\0b' },
    { shell: 'cmd', cols: 0 },
    { shell: 'cmd', rows: 1.5 },
    { shell: 'cmd', title: 'x'.repeat(257) },
    {},
    { shell: 'cmd', command: { commandLine: 'x', label: 'X' } },
    { command: { file: 'claude.exe', label: 'X' } },
    { command: { file: '\\\\server\\share\\a.exe', label: 'X' } },
    { command: { file: 'C:\\a.exe', args: 'x', label: 'X' } },
    { command: { file: 'C:\\a.exe', args: ['a\0b'], label: 'X' } },
    { command: { file: 'C:\\a.exe', commandLine: 'x', label: 'X' } },
    { command: { commandLine: 'a\r\nb', label: 'X' } },
    { command: { commandLine: 'x', label: '' } },
    { command: { commandLine: 'x', label: 'X', env: { 'A=B': 'x' } } },
    { command: { commandLine: 'x', label: 'X', env: { A: 1 } } },
    { command: { commandLine: 'x', label: 'X', env: ['A'] } },
  ])('rejects create options %j', (options) => {
    expect(() => parseCreateOptions(options)).toThrow(HostApiError);
  });
});

describe('small validators', () => {
  test('parseSize rejects out-of-range dimensions', () => {
    expect(() => parseSize({ cols: 10_001, rows: 1 })).toThrow(/size/);
  });

  test('parseSessionId rejects ids longer than 64 characters', () => {
    expect(() => parseSessionId('a'.repeat(65))).toThrow(/session id/);
  });
});

describe('web-side parsers', () => {
  test('parseHelloReply accepts success and failure replies', () => {
    expect(parseHelloReply({ ok: true, v: V, pid: 42 })).toEqual({ ok: true, v: V, pid: 42 });
    expect(parseHelloReply({ ok: false, error: 'unauthorized', message: 'bad token' })).toEqual({
      ok: false,
      error: 'unauthorized',
      message: 'bad token',
    });
    expect(() => parseHelloReply({ ok: true })).toThrow(HostApiError);
  });

  test('parseControlMessage tells responses from events', () => {
    expect(parseControlMessage({ event: 'removed', session: 's1' })).toEqual({ event: 'removed', session: 's1' });
    const notice = { event: 'notice', session: 's1', title: '', body: 'done', at: 1 };
    expect(parseControlMessage(notice)).toEqual(notice);
    expect(() => parseControlMessage({ event: 'other', session: 's1' })).toThrow(HostApiError);
    expect(parseControlMessage({ id: 1, ok: true, result: {} })).toEqual({ id: 1, ok: true, result: {} });
    expect(() => parseControlMessage({ id: 'x', ok: true })).toThrow(HostApiError);
  });
});
