import type { IncomingMessage } from 'node:http';
import { describe, expect, test } from 'vitest';
import { clearSessionCookie, clientAddress, SESSION_COOKIE, sessionCookie, sessionToken, writeCheck, WRITE_HEADER } from '../src/request-auth.js';

function request(remoteAddress: string, headers: Record<string, string> = {}, method = 'GET'): IncomingMessage {
  return { method, headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('clientAddress', () => {
  test('uses the connection address when it is not loopback', () => {
    expect(clientAddress(request('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }))).toBe('203.0.113.9');
  });

  test('trusts the last X-Forwarded-For hop only from a loopback proxy', () => {
    expect(clientAddress(request('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }))).toBe('198.51.100.7');
    expect(clientAddress(request('::ffff:127.0.0.1', { 'x-forwarded-for': '198.51.100.8' }))).toBe('198.51.100.8');
    expect(clientAddress(request('::1', { 'x-forwarded-for': ' 2001:db8::1 ' }))).toBe('2001:db8::1');
    expect(clientAddress(request('127.0.0.1'))).toBe('127.0.0.1');
    const repeated = { method: 'GET', headers: { 'x-forwarded-for': ['6.6.6.6', '198.51.100.9'] }, socket: { remoteAddress: '127.0.0.1' } };
    expect(clientAddress(repeated as unknown as IncomingMessage)).toBe('198.51.100.9');
  });

  test('ignores a forwarded value that is not an address', () => {
    expect(clientAddress(request('127.0.0.1', { 'x-forwarded-for': 'evil<script>' }))).toBe('127.0.0.1');
    expect(clientAddress(request('127.0.0.1', { 'x-forwarded-for': '' }))).toBe('127.0.0.1');
  });

  test('copes with a socket that has no address', () => {
    expect(clientAddress(request(undefined as unknown as string))).toBe('unknown');
  });
});

describe('session cookie', () => {
  test('is host-only, secure, HttpOnly, strict and lasts the session length', () => {
    expect(sessionCookie('tok', 30 * 24 * 3600_000)).toBe(`${SESSION_COOKIE}=tok; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`);
    expect(clearSessionCookie()).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  });

  test('is read back from the Cookie header among others', () => {
    expect(sessionToken(request('127.0.0.1', { cookie: `a=1; ${SESSION_COOKIE}=abc_-9; b=2` }))).toBe('abc_-9');
    expect(sessionToken(request('127.0.0.1', { cookie: 'a=1' }))).toBeUndefined();
    expect(sessionToken(request('127.0.0.1'))).toBeUndefined();
  });
});

describe('writeCheck', () => {
  const origins = ['http://127.0.0.1:7690', 'https://vesper.example.com'];

  test('accepts a request from an allowed origin that carries the custom header', () => {
    expect(writeCheck(request('127.0.0.1', { origin: 'https://vesper.example.com', [WRITE_HEADER]: '1' }, 'POST'), origins)).toBeUndefined();
  });

  test.each([
    [{ [WRITE_HEADER]: '1' }, 'origin'],
    [{ origin: 'https://evil.example', [WRITE_HEADER]: '1' }, 'origin'],
    [{ origin: 'null', [WRITE_HEADER]: '1' }, 'origin'],
    [{ origin: 'https://vesper.example.com' }, WRITE_HEADER],
  ])('refuses %j', (headers, problem) => {
    expect(writeCheck(request('127.0.0.1', headers, 'POST'), origins)).toContain(problem);
  });
});
