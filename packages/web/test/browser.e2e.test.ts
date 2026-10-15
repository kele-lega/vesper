import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame } from '@vesper/protocol';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

const SLOW = 60_000;
const PORT = 18_690 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const entry = fileURLToPath(new URL('../dist/demo-server.js', import.meta.url));
const artifacts = fileURLToPath(new URL('../../../.vesper-dev/', import.meta.url));

function startServer(): Promise<{ child: ChildProcess; token: string }> {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, VESPER_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const token = /token=(\S+)/.exec(out)?.[1];
      if (token) resolve({ child, token });
    });
    child.once('exit', (code) => reject(new Error(`demo server exited early with ${code}`)));
  });
}

/** Attaches a second client to a session and returns the text of the snapshot it receives. */
async function snapshotText(token: string, session: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}&session=${session}&shell=cmd`, { origin: BASE });
  const text = await new Promise<string>((resolve, reject) => {
    ws.on('message', (raw: Buffer) => {
      const frame = decodeFrame(raw);
      if (frame.type === 'snapshot') resolve(new TextDecoder().decode(frame.data));
    });
    ws.once('error', reject);
    ws.once('open', () => ws.send(encodeFrame({ type: 'resize', cols: 120, rows: 30 })));
  });
  ws.close();
  return text;
}

describe.runIf(process.platform === 'win32')('M0 demo in a real browser (system Edge)', () => {
  let server: { child: ChildProcess; token: string };
  let browser: Browser;
  beforeAll(async () => {
    server = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  }, SLOW);
  afterAll(async () => {
    await browser?.close();
    server?.child.kill();
  });

  test('renders the terminal, echoes typing, and a second device sees the same screen', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${BASE}/?token=${server.token}&session=browser&shell=cmd`);
    await page.waitForSelector('#dot.online');
    expect(page.url()).not.toContain('token=');

    await page.locator('#terminal').click();
    await page.keyboard.type('echo vesper-%OS%', { delay: 40 });
    await page.keyboard.press('Enter');
    await expect.poll(() => snapshotText(server.token, 'browser'), { timeout: 15_000 }).toContain('vesper-Windows_NT');

    const status = (await page.locator('#status').textContent()) ?? '';
    const samples = Number(/（(\d+) 次）/.exec(status)?.[1] ?? 0);
    expect(samples).toBeGreaterThanOrEqual(10);
    console.log(`browser status bar: ${status}`);

    const renderer = await page.evaluate(() => (document.querySelector('.xterm canvas') ? 'webgl' : 'dom'));
    const font = await page.evaluate(() => document.fonts.check('16px "Cascadia Mono Variable"'));
    console.log(`renderer=${renderer} cascadia-loaded=${font}`);
    expect(font).toBe(true);

    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}m0-demo.png` });

    // Reloading reattaches to the same shell, although the token is gone from the address bar.
    await page.reload();
    await page.waitForSelector('#dot.online');
    await page.locator('#terminal').click();
    await page.keyboard.type('echo again-%OS%', { delay: 20 });
    await page.keyboard.press('Enter');
    await expect.poll(() => snapshotText(server.token, 'browser'), { timeout: 15_000 }).toMatch(/vesper-Windows_NT[\s\S]*again-Windows_NT/);
    expect(errors).toEqual([]);
  }, SLOW);
});
