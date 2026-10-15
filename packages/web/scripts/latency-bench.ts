/**
 * Measures keystroke echo latency through the demo server's WebSocket:
 * browser frame -> server -> ConPTY -> shell echo -> server -> frame.
 * Excludes browser rendering. Starts its own demo server unless VESPER_URL is set.
 *
 *   npm run bench -- [shell] [samples]      shell: powershell | cmd | gitbash
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeFrame, encodeFrame } from '@vesper/protocol';
import WebSocket from 'ws';

const shell = process.argv[2] ?? 'powershell';
const samples = Number(process.argv[3] ?? 200);
const QUIET_MS = 1500;
const GAP_MS = 30;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(): Promise<{ url: URL; stop: () => void }> {
  const entry = fileURLToPath(new URL('../dist/demo-server.js', import.meta.url));
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<URL>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /http:\/\/\S+token=\S+/.exec(out);
      if (match) resolve(new URL(match[0]));
    });
    child.on('exit', (code) => reject(new Error(`demo server exited with ${code}`)));
  });
  return { url, stop: () => child.kill() };
}

async function measure(base: URL): Promise<void> {
  const ws = new WebSocket(
    `ws://${base.host}/ws?token=${base.searchParams.get('token')}&session=bench-${Date.now()}&shell=${shell}`,
    { origin: `http://${base.host}`, perMessageDeflate: false },
  );
  let lastOutputAt = 0;
  let firstOutputAt = 0;
  let onEcho: (() => void) | undefined;
  const openedAt = performance.now();
  ws.on('message', (raw: Buffer) => {
    const frame = decodeFrame(raw);
    if (frame.type !== 'output') return;
    lastOutputAt = performance.now();
    firstOutputAt ||= lastOutputAt;
    onEcho?.();
    onEcho = undefined;
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  ws.send(encodeFrame({ type: 'resize', cols: 120, rows: 30 }));

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
  ws.send(encodeFrame({ type: 'input', data: Buffer.from('\x1b\x03') }));
  ws.close();

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length;
  const fmt = (ms: number) => `${ms.toFixed(2)}ms`;
  console.log(`shell=${shell} samples=${samples} ready-for-input≈${Math.round(startup)}ms after connect (upper bound: includes ${QUIET_MS}ms quiet wait)`);
  console.log(`echo p50=${fmt(percentile(sorted, 0.5))} p95=${fmt(percentile(sorted, 0.95))} p99=${fmt(percentile(sorted, 0.99))} max=${fmt(sorted.at(-1) ?? NaN)} mean=${fmt(mean)}`);
}

const server = process.env['VESPER_URL'] ? undefined : await startServer();
try {
  await measure(server?.url ?? new URL(process.env['VESPER_URL']!));
} finally {
  server?.stop();
}
