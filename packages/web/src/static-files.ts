import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export interface StaticResponse {
  status: number;
  type: string;
  body: Buffer | string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT = 'text/plain; charset=utf-8';

/** Serves the built UI; page routes such as /s/<id> get index.html. */
export function staticFiles(root: string): (url: string) => Promise<StaticResponse> {
  const base = root.endsWith(sep) ? root : root + sep;
  return async (url) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
    } catch {
      return { status: 400, type: TEXT, body: 'bad request' };
    }
    if (pathname.includes('\0')) return { status: 400, type: TEXT, body: 'bad request' };
    const page = pathname === '/' || !extname(pathname);
    const file = normalize(join(base, page ? 'index.html' : pathname));
    if (!file.startsWith(base)) return { status: 403, type: TEXT, body: 'forbidden' };
    try {
      return { status: 200, type: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', body: await readFile(file) };
    } catch {
      return { status: 404, type: TEXT, body: 'not found' };
    }
  };
}

/** Headers on every response. xterm.js sets inline styles, so styles may be inline; scripts may not. */
export function securityHeaders(origins: string[]): Record<string, string> {
  const sockets = origins.map((origin) => origin.replace(/^http/, 'ws'));
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self' ${sockets.join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  };
}
