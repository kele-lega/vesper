import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ControlClient, hostPaths, readRunInfo } from '@vesper/ptyd/client';

const SLOW = 120_000;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB_MAIN = join(ROOT, 'packages', 'web', 'dist', 'main.js');
const artifacts = join(ROOT, '.vesper-dev');
const PORT = 18_690 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

declare global {
  interface Window {
    vesperTerminal?: { text(): string; screen(): string; size(): { cols: number; rows: number }; echoMedian(): number | undefined };
  }
}

function startWeb(home: string): Promise<{ child: ChildProcess; link: string }> {
  const child = spawn(process.execPath, [WEB_MAIN], {
    env: { ...process.env, VESPER_HOME: home, VESPER_PORT: String(PORT), VESPER_DEFAULT_CWD: tmpdir() },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const link = /http:\/\/\S+#token=\S+/.exec(out)?.[0];
      if (link && out.includes('Terminal host ready')) resolve({ child, link });
    });
    child.once('exit', (code) => reject(new Error(`vesper-web exited early with ${code}`)));
  });
}

const screen = (page: Page) => page.evaluate(() => window.vesperTerminal?.text() ?? '');
const waitForScreen = (page: Page, text: string, timeout = 30_000) =>
  page.waitForFunction((wanted) => window.vesperTerminal?.text().includes(wanted) ?? false, text, { timeout });

async function openPage(context: BrowserContext, url: string, errors: string[]): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // CSP violations are console errors, not page errors; failed loads are recorded with their URL.
  // While the test has the web server stopped, the browser logs each refused reconnect: expected.
  page.on('console', (message) => {
    const text = message.text();
    const expectedOutage = /^WebSocket connection to .* failed: .*ERR_CONNECTION_REFUSED/.test(text);
    if (message.type() === 'error' && !text.startsWith('Failed to load resource') && !expectedOutage) errors.push(text);
  });
  page.on('response', (response) => {
    // API errors are expected while the test restarts the servers (the page asks why it lost its socket).
    if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(url);
  return page;
}

describe.runIf(process.platform === 'win32')('M1 in a real browser (system Edge)', () => {
  let home: string;
  let web: { child: ChildProcess; link: string };
  let browser: Browser;

  beforeAll(async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    home = mkdtempSync(join(tmpdir(), 'vesper-e2e-'));
    web = await startWeb(home);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  }, SLOW);

  afterAll(async () => {
    await browser?.close();
    web?.child.kill();
    const run = home ? readRunInfo(hostPaths(home).runFile) : undefined;
    if (run) await (await ControlClient.connect({ pipe: run.pipe, token: run.token })).shutdown().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, SLOW);

  test('sessions outlive the page, the web server and the terminal host', async () => {
    const errors: string[] = [];
    const desk = await browser.newContext({ viewport: { width: 1100, height: 640 } });
    await desk.addInitScript(() => localStorage.setItem('vesper-debug', '1'));
    const picker = await openPage(desk, web.link, errors);
    expect(picker.url()).toBe(`${BASE}/`);

    // Create a session from the list page and type into it.
    await picker.selectOption('#shell', 'cmd');
    await picker.click('button[type=submit]');
    await picker.waitForURL(/\/s\/[\w-]+$/);
    const page = picker;
    await page.waitForSelector('#dot.online');
    // The WebGL renderer and Windows Terminal's font, as in M0 (the DOM fallback is about 4x slower to paint).
    expect(await page.evaluate(() => document.querySelector('.xterm canvas') !== null)).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('16px "Cascadia Mono Variable"'))).toBe(true);
    await page.keyboard.type('echo first-%OS%');
    await page.keyboard.press('Enter');
    await waitForScreen(page, 'first-Windows_NT');

    // Reloading resumes the same shell.
    await page.reload();
    await waitForScreen(page, 'first-Windows_NT');
    await page.waitForSelector('#dot.online');
    // Typed at a human pace, each key is its own echo; the meter times keypress to painted echo.
    await page.keyboard.type('echo after-reload-%OS%', { delay: 40 });
    await page.waitForTimeout(200);
    const echoMedian = await page.evaluate(() => window.vesperTerminal!.echoMedian());
    console.log(`echo median in the browser: ${echoMedian?.toFixed(2)}ms`);
    // Headless Edge here measures 9-13 ms (a quiet page measures about 3 ms; the rest is this test's own
    // polling). The check is for a regression to frame-quantized echo, 16 ms or more.
    expect(echoMedian).toBeLessThan(15);
    await page.keyboard.press('Enter');
    await waitForScreen(page, 'after-reload-Windows_NT');

    // Restarting vesper-web leaves the shell running; the page reconnects by itself.
    web.child.kill();
    await new Promise((resolve) => web.child.once('exit', resolve));
    web = await startWeb(home);
    await page.waitForSelector('#dot.online', { timeout: 30_000 });
    await page.keyboard.type('echo after-web-restart-%OS%');
    await page.keyboard.press('Enter');
    await waitForScreen(page, 'after-web-restart-Windows_NT');

    // Stopping the terminal host ends the shell; the next host restarts it below its history.
    const run = readRunInfo(hostPaths(home).runFile)!;
    await (await ControlClient.connect({ pipe: run.pipe, token: run.token })).shutdown();
    await waitForScreen(page, '已恢复历史', 60_000);
    expect(await screen(page)).toContain('after-web-restart-Windows_NT');
    await page.waitForSelector('#dot.online');
    await page.keyboard.type('echo after-host-restart-%OS%');
    await page.keyboard.press('Enter');
    await waitForScreen(page, 'after-host-restart-Windows_NT');
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'm1-restored.png') });

    // A second, smaller device sees the same session; typing there makes it follow that size.
    const laptop = await browser.newContext({ viewport: { width: 760, height: 480 } });
    await laptop.addInitScript(() => localStorage.setItem('vesper-debug', '1'));
    const other = await openPage(laptop, `${page.url()}#token=${new URL(web.link).hash.slice('#token='.length)}`, errors);
    await waitForScreen(other, 'after-host-restart-Windows_NT');
    const deskSize = await page.evaluate(() => window.vesperTerminal!.size());
    await other.keyboard.type('echo from-laptop-%OS%');
    await other.keyboard.press('Enter');
    await waitForScreen(page, 'from-laptop-Windows_NT');
    // The resize waits until the typing has gone quiet, then reaches both windows.
    await other.waitForFunction((desk) => window.vesperTerminal!.size().cols < desk, deskSize.cols);
    const laptopSize = await other.evaluate(() => window.vesperTerminal!.size());
    await page.waitForFunction((wanted) => window.vesperTerminal!.size().cols === wanted, laptopSize.cols);
    expect(laptopSize.cols).toBeLessThan(deskSize.cols);
    // At the new size, the next command lands on its own rows in both windows: nothing writes over old lines.
    // (The width change makes ConPTY reflow; older lines may move into scrollback, as in Windows Terminal.)
    await other.keyboard.type('echo after-takeover-%OS%');
    await other.keyboard.press('Enter');
    const settledAfterTakeover = () => /after-takeover-Windows_NT\n\n.*>$/.test(window.vesperTerminal!.screen());
    await other.waitForFunction(settledAfterTakeover);
    await page.waitForFunction(settledAfterTakeover);
    const deskScreen = await page.evaluate(() => window.vesperTerminal!.screen());
    const laptopScreen = await other.evaluate(() => window.vesperTerminal!.screen());
    expect(deskScreen).toBe(laptopScreen);
    expect(deskScreen.split('\n').slice(-4)).toEqual([
      expect.stringMatching(/^C:\\.*>echo after-takeover-%OS%$/),
      'after-takeover-Windows_NT',
      '',
      expect.stringMatching(/^C:\\.*>$/),
    ]);
    await page.screenshot({ path: join(artifacts, 'm1-two-devices.png') });

    // Back on the list page, the session shows two windows and can be closed.
    const list = await openPage(desk, `${BASE}/`, errors);
    await list.waitForSelector('.session .name');
    expect(await list.textContent('.sessions')).toContain('2 个窗口');
    await list.screenshot({ path: join(artifacts, 'm1-sessions.png') });
    list.on('dialog', (dialog) => void dialog.accept());
    await list.click('.session .close');
    await list.waitForSelector('.empty');
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '会话已关闭');

    expect(errors).toEqual([]);
    await laptop.close();
    await desk.close();
  }, SLOW * 2);
});
