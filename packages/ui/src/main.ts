import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { CAMPBELL, decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import { splitInput } from './input.js';
import { guardTerminalQueries } from './query-guard.js';
import './style.css';

const FONT_FAMILY = '"Cascadia Mono Variable", "Cascadia Mono", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", monospace';
const PING_INTERVAL_MS = 10_000;
const DEAD_AFTER_MS = 2 * PING_INTERVAL_MS;
const MAX_BACKOFF_MS = 10_000;
/** Keeps every input frame far below the server's 1 MiB frame limit. */
const MAX_INPUT_CHARS = 16_384;
/** Sent by the server when the shell has ended; reconnecting would start a new one. */
const CLOSE_SESSION_ENDED = 4000;

const params = new URLSearchParams(location.search);
// The token is removed from the address bar below; keep it for reloads of this tab only.
const token = params.get('token') ?? sessionStorage.getItem('vesper-token') ?? '';
sessionStorage.setItem('vesper-token', token);
const sessionName = params.get('session') ?? 'main';
const shell = params.get('shell') ?? 'powershell';
history.replaceState(null, '', `${location.pathname}?session=${encodeURIComponent(sessionName)}&shell=${encodeURIComponent(shell)}`);

const container = document.getElementById('terminal')!;
const dot = document.getElementById('dot')!;
const title = document.getElementById('title')!;
const status = document.getElementById('status')!;

// Windows Terminal defaults: Campbell, Cascadia Mono 12pt (16px), bar cursor, 9001 lines.
const term = new Terminal({
  fontFamily: FONT_FAMILY, fontSize: 16, lineHeight: 1, letterSpacing: 0,
  cursorStyle: 'bar', cursorBlink: true, scrollback: 9001, theme: { ...CAMPBELL },
  allowProposedApi: true, windowsPty: { backend: 'conpty', buildNumber: 19045 },
});
const fit = new FitAddon();
const encoder = new TextEncoder();
const latencies: number[] = [];
let socket: WebSocket | undefined;
let ended = false;
let attempt = 0;
let lastFrameAt = 0;
let pendingInputAt: number | undefined;
let rtt: number | undefined;
let ping: { nonce: number; sentAt: number } | undefined;

function send(frame: Frame): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame));
}

function fitAndReport(): void {
  fit.fit();
  send({ type: 'resize', cols: term.cols, rows: term.rows });
}

function showStatus(online: boolean): void {
  dot.className = `dot ${online ? 'online' : 'offline'}`;
  if (ended) {
    status.textContent = '会话已结束';
    return;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted.length ? `${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms` : '–';
  const last = latencies.length ? `${latencies[latencies.length - 1]!.toFixed(1)}ms` : '–';
  status.textContent = online
    ? `回显 ${last} · 中位 ${median}（${latencies.length} 次）· 心跳 ${rtt === undefined ? '–' : `${rtt.toFixed(1)}ms`}`
    : '连接已断开，正在重连…';
}

function handleFrame(frame: Frame): void {
  switch (frame.type) {
    case 'snapshot':
      term.reset();
      term.resize(frame.cols, frame.rows);
      term.write(frame.data, fitAndReport);
      return;
    case 'output': {
      const startedAt = pendingInputAt;
      pendingInputAt = undefined;
      term.write(frame.data, () => {
        // Measure until the echo is painted, not just received.
        if (startedAt !== undefined) requestAnimationFrame(() => recordLatency(performance.now() - startedAt));
      });
      return;
    }
    case 'pong':
      if (ping?.nonce !== frame.nonce) return;
      rtt = performance.now() - ping.sentAt;
      ping = undefined;
      showStatus(true);
      return;
    case 'exit':
      term.write(`\r\n\x1b[90m[进程已退出，代码 ${frame.code}。刷新页面会新开一个 shell]\x1b[0m\r\n`);
      return;
    default:
      return;
  }
}

function recordLatency(ms: number): void {
  latencies.push(ms);
  if (latencies.length > 200) latencies.shift();
  showStatus(true);
}

function connect(): void {
  const query = new URLSearchParams({ token, session: sessionName, shell });
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${query}`);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    lastFrameAt = performance.now();
    showStatus(true);
    fitAndReport();
  };
  ws.onmessage = (event) => {
    if (socket !== ws || !(event.data instanceof ArrayBuffer)) return;
    lastFrameAt = performance.now();
    try {
      handleFrame(decodeFrame(new Uint8Array(event.data)));
    } catch (error) {
      console.warn('ignoring a malformed frame', error);
    }
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = undefined;
    if (event.code === CLOSE_SESSION_ENDED) {
      ended = true;
      showStatus(false);
    } else {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect(): void {
  showStatus(false);
  const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt++);
  setTimeout(() => socket ?? (ended || connect()), backoff * (0.8 + Math.random() * 0.4));
}

function reconnectNow(): void {
  if (ended) return;
  const old = socket;
  socket = undefined;
  old?.close();
  connect();
}

function loadAddons(): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (error) {
    console.warn('WebGL unavailable, falling back to the DOM renderer', error);
  }
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon());
  // The pty host answers terminal queries; replies from each attached browser would reach the shell as typed input.
  guardTerminalQueries(term.parser);
}

function installInput(): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey) return true;
    if (event.key === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    return event.key !== 'v'; // let the browser paste; xterm turns the paste event into input
  });
  term.onData((data) => {
    pendingInputAt ??= performance.now();
    for (const piece of splitInput(data, MAX_INPUT_CHARS)) send({ type: 'input', data: encoder.encode(piece) });
  });
  term.onTitleChange((text) => {
    title.textContent = text || `${sessionName} · ${shell}`;
  });
  title.textContent = `${sessionName} · ${shell}`;
}

function installResizeAndHeartbeat(): void {
  let resizeTimer: number | undefined;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(fitAndReport, 50);
  }).observe(container);

  setInterval(() => {
    if (!socket || ended) return;
    if (performance.now() - lastFrameAt > DEAD_AFTER_MS) return reconnectNow();
    ping = { nonce: Math.floor(Math.random() * 0xffffffff), sentAt: performance.now() };
    send({ type: 'ping', nonce: ping.nonce });
  }, PING_INTERVAL_MS);
  window.addEventListener('online', () => socket?.readyState !== WebSocket.OPEN && reconnectNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket?.readyState !== WebSocket.OPEN) reconnectNow();
  });
}

async function main(): Promise<void> {
  await document.fonts.load(`16px "Cascadia Mono Variable"`);
  term.open(container);
  loadAddons();
  installInput();
  installResizeAndHeartbeat();
  connect();
  term.focus();
}

void main();
