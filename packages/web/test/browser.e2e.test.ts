import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ControlClient, hostPaths, readRunInfo } from '@vesper/ptyd/client';
import { AuthStore } from '../src/auth-store.js';
import { hashPassword } from '../src/password.js';
import { openWebDatabase, webDatabasePath } from '../src/web-db.js';

const SLOW = 120_000;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB_MAIN = join(ROOT, 'packages', 'web', 'dist', 'main.js');
const artifacts = join(ROOT, '.vesper-dev');
const PORT = 18_690 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';

declare global {
  interface Window {
    vesperTerminal?: { text(): string; screen(): string; size(): { cols: number; rows: number }; echoMedian(): number | undefined };
  }
}

function startWeb(home: string, workDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WEB_MAIN], {
    env: { ...process.env, VESPER_HOME: home, VESPER_PORT: String(PORT), VESPER_DEFAULT_CWD: workDir, VESPER_WT_SETTINGS: 'none' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('Terminal host ready')) resolve(child);
    });
    child.once('exit', (code) => reject(new Error(`vesper-web exited early with ${code}`)));
  });
}

const screen = (page: Page) => page.evaluate(() => window.vesperTerminal?.text() ?? '');
const waitForScreen = (page: Page, text: string, timeout = 30_000) =>
  page.waitForFunction((wanted) => window.vesperTerminal?.text().includes(wanted) ?? false, text, { timeout });
const waitOnline = (page: Page, timeout = 30_000) => page.waitForSelector('.terminal:not([hidden])[data-state=online]', { timeout });
async function run(page: Page, command: string, expected: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await waitForScreen(page, expected);
}

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

async function logIn(page: Page): Promise<void> {
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
}

describe.runIf(process.platform === 'win32')('M2a in a real browser (system Edge)', () => {
  let home: string;
  let web: ChildProcess;
  let browser: Browser;

  beforeAll(async () => {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
    home = mkdtempSync(join(tmpdir(), 'vesper-e2e-'));
    mkdirSync(join(home, 'work'));
    const db = openWebDatabase(webDatabasePath(home));
    new AuthStore(db).setPasswordHash(await hashPassword(PASSWORD, { N: 1 << 10, r: 8, p: 1 }));
    db.close();
    web = await startWeb(home, join(home, 'work'));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  }, SLOW);

  afterAll(async () => {
    await browser?.close();
    web?.kill();
    const info = home ? readRunInfo(hostPaths(home).runFile) : undefined;
    if (info) await (await ControlClient.connect({ pipe: info.pipe, token: info.token })).shutdown().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, SLOW);

  test('log in, open a project tab; it outlives the page, the web server and the terminal host', async () => {
    const errors: string[] = [];
    const desk = await browser.newContext({ viewport: { width: 1100, height: 640 } });
    await desk.addInitScript(() => localStorage.setItem('vesper-debug', '1'));
    const page = await openPage(desk, `${BASE}/`, errors);

    // The login cookie is __Host- and Secure; browsers keep it on http://127.0.0.1 too.
    await logIn(page);
    await page.click('.card.new');
    await page.fill('#project-name', 'e2e-demo');
    await page.click('.dialog button[type=submit]');
    await page.waitForURL(/\/p\/[\w-]+$/);
    await page.click('.profile-buttons button:text-is("命令提示符")');
    await page.waitForURL(/\/p\/[\w-]+\?tab=[\w-]+$/);
    await waitOnline(page);
    // The WebGL renderer and Windows Terminal's font, as in M0 (the DOM fallback is about 4x slower to paint).
    expect(await page.evaluate(() => document.querySelector('.terminal:not([hidden]) .xterm canvas') !== null)).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('16px "Cascadia Mono"'))).toBe(true);
    // The tab starts in the project's folder, made under the default folder.
    await run(page, 'cd', join(home, 'work', 'e2e-demo'));

    // Reloading resumes the same shell.
    await page.reload();
    await waitOnline(page);
    await waitForScreen(page, join(home, 'work', 'e2e-demo'));
    // Typed at a human pace, each key is its own echo; the meter times keypress to painted echo.
    await page.keyboard.type('echo after-reload-%OS%', { delay: 40 });
    await page.waitForTimeout(200);
    const echoMedian = await page.evaluate(() => window.vesperTerminal!.echoMedian());
    console.log(`echo median in the browser: ${echoMedian?.toFixed(2)}ms`);
    expect(echoMedian).toBeLessThan(15);
    await page.keyboard.press('Enter');
    await waitForScreen(page, 'after-reload-Windows_NT');

    // Restarting vesper-web leaves the shell running; the page reconnects by itself, still logged in.
    web.kill();
    await new Promise((resolve) => web.once('exit', resolve));
    web = await startWeb(home, join(home, 'work'));
    await waitOnline(page);
    await run(page, 'echo after-web-restart-%OS%', 'after-web-restart-Windows_NT');

    // Stopping the terminal host ends the shell; the next host restarts it below its history.
    const info = readRunInfo(hostPaths(home).runFile)!;
    await (await ControlClient.connect({ pipe: info.pipe, token: info.token })).shutdown();
    await waitForScreen(page, '已恢复历史', 60_000);
    expect(await screen(page)).toContain('after-web-restart-Windows_NT');
    await waitOnline(page);
    await run(page, 'echo after-host-restart-%OS%', 'after-host-restart-Windows_NT');
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'm2-project-tab.png') });

    // A second device logs in by itself and types into the same tab.
    const laptop = await browser.newContext({ viewport: { width: 760, height: 480 } });
    await laptop.addInitScript(() => localStorage.setItem('vesper-debug', '1'));
    const other = await openPage(laptop, page.url(), errors);
    await logIn(other);
    await waitOnline(other);
    await waitForScreen(other, 'after-host-restart-Windows_NT');
    await run(other, 'echo from-laptop-%OS%', 'from-laptop-Windows_NT');
    await waitForScreen(page, 'from-laptop-Windows_NT');

    // A second tab, then closing both from the tab bar empties the project.
    await page.click('.tab-new:not([aria-haspopup])');
    await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2);
    await waitOnline(page);
    await page.screenshot({ path: join(artifacts, 'm2-two-tabs.png') });
    page.on('dialog', (dialog) => void dialog.accept());
    await page.click('.tab.active .tab-close');
    await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1);
    await page.click('.tab.active .tab-close');
    await page.waitForSelector('.empty-project');
    await other.waitForSelector('.empty-project');

    expect(errors).toEqual([]);
    await laptop.close();
    await desk.close();
  }, SLOW * 2);
});
