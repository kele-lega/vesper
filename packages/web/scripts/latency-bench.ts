/**
 * Measures keystroke echo latency through the full M1 path:
 * client frame -> vesper-web -> named pipe -> vesper-ptyd -> ConPTY -> shell echo -> back.
 * Excludes browser rendering. Starts its own web server and host in a temporary
 * VESPER_HOME unless VESPER_URL (http://host:port/#token=...) is set.
 *
 *   npm run bench -- [shell] [samples]      shell: powershell | cmd | gitbash
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame } from '@vesper/protocol';
import { ControlClient, hostPaths, readRunInfo } from '@vesper/ptyd/client';
import WebSocket from 'ws';

const shell = process.argv[2] ?? 'powershell';
const samples = Number(process.argv[3] ?? 200);
const QUIET_MS = 1500;
const GAP_MS = 30;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Target {
  base: URL;
  token: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<Target> {
  const home = mkdtempSync(join(tmpdir(), 'vesper-bench-'));
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, VESPER_HOME: home, VESPER_PORT: '0' } });
  const url = await new Promise<URL>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /http:\/\/\S+#token=\S+/.exec(out);
      if (match) resolve(new URL(match[0]));
    });
    child.on('exit', (code) => reject(new Error(`web server exited with ${code}`)));
  });
  const stop = async () => {
    child.kill();
    const run = readRunInfo(hostPaths(home).runFile);
    if (run) await (await ControlClient.connect({ pipe: run.pipe, token: run.token })).shutdown().catch(() => undefined);
    await sleep(500);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { base: url, token: url.hash.replace('#token=', ''), stop };
}

async function api(target: Target, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, target.base), {
    method,
    headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return response.json();
}

async function measure(target: Target): Promise<void> {
  const { session } = (await api(target, 'POST', '/api/sessions', { shell, cols: 120, rows: 30 })) as { session: { id: string } };
  const ws = new WebSocket(`ws://${target.base.host}/ws/sessions/${session.id}?cols=120&rows=30`, ['vesper.v1', `vesper.token.${target.token}`], {
    origin: `http://${target.base.host}`,
    perMessageDeflate: false,
  });
  let lastOutputAt = 0;
  let firstOutputAt = 0;
  let onEcho: (() => void) | undefined;
  const openedAt = performance.now();
  ws.on('message', (raw: Buffer) => {
    const frame = decodeFrame(raw);
    if (frame.type !== 'output') return;
    ws.send(encodeFrame({ type: 'ack', seq: frame.seq + frame.data.length }));
    lastOutputAt = performance.now();
    firstOutputAt ||= lastOutputAt;
    onEcho?.();
    onEcho = undefined;
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));

  // Startup output can pause (PowerShell profiles do), so "quiet" alone does not mean ready.
  // Type a warm-up key and wait for its echo: the shell is ready once it reads input.
  while (!firstOutputAt || performance.now() - lastOutputAt < QUIET_MS) await sleep(50);
  const warmEcho = new Promise<void>((resolve) => (onEcho = resolve));
  ws.send(encodeFrame({ type: 'input', data: Buffer.from('w') }));
  await Promise.race([warmEcho, sleep(15_000)]);
  const startup = performance.now() - openedAt;
  while (performance.now() - lastOutputAt < QUIET_MS) await sleep(50);

  const latencies: number[] = [];
  for (let i = 0; i < samples; i++) {
    const echoed = new Promise<void>((resolve) => (onEcho = resolve));
    const sentAt = performance.now();
    ws.send(encodeFrame({ type: 'input', data: Buffer.from(String.fromCharCode(97 + (i % 26))) }));
    await Promise.race([echoed, sleep(2000)]);
    latencies.push(performance.now() - sentAt);
    await sleep(GAP_MS);
  }
  ws.close();
  await api(target, 'DELETE', `/api/sessions/${session.id}`);

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length;
  const fmt = (ms: number) => `${ms.toFixed(2)}ms`;
  console.log(`shell=${shell} samples=${samples} ready-for-input≈${Math.round(startup)}ms after connect (upper bound: includes ${QUIET_MS}ms quiet wait)`);
  console.log(`echo p50=${fmt(percentile(sorted, 0.5))} p95=${fmt(percentile(sorted, 0.95))} p99=${fmt(percentile(sorted, 0.99))} max=${fmt(sorted.at(-1) ?? NaN)} mean=${fmt(mean)}`);
}

const given = process.env['VESPER_URL'];
const target: Target = given
  ? { base: new URL(given), token: new URL(given).hash.replace('#token=', ''), stop: async () => undefined }
  : await startServer();
try {
  await measure(target);
} finally {
  await target.stop();
}
