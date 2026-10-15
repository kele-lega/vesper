import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { decodeFrame, encodeFrame, type Frame } from '@vesper/protocol';
import './style.css';

// Windows Terminal defaults: Campbell, Cascadia Mono 12pt (16px), bar cursor, 9001 lines.
const CAMPBELL = {
  background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', cursorAccent: '#0C0C0C',
  selectionBackground: '#FFFFFF', selectionForeground: '#0C0C0C',
  black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00',
  blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
  brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
};
const FONT_FAMILY = '"Cascadia Mono Variable", "Cascadia Mono", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", monospace';
const PING_INTERVAL_MS = 10_000;
const DEAD_AFTER_MS = 2 * PING_INTERVAL_MS;
const MAX_BACKOFF_MS = 10_000;

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

const term = new Terminal({
  fontFamily: FONT_FAMILY, fontSize: 16, lineHeight: 1, letterSpacing: 0,
  cursorStyle: 'bar', cursorBlink: true, scrollback: 9001, theme: CAMPBELL,
  allowProposedApi: true, windowsPty: { backend: 'conpty', buildNumber: 19045 },
});
const fit = new FitAddon();
const encoder = new TextEncoder();
const latencies: number[] = [];
let socket: WebSocket | undefined;
let attempt = 0;
let lastFrameAt = 0;
let pendingInputAt: number | undefined;
let rtt: number | undefined;
let pingSentAt = 0;

function send(frame: Frame): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame));
}

function fitAndReport(): void {
  fit.fit();
  send({ type: 'resize', cols: term.cols, rows: term.rows });
}

function showStatus(online: boolean): void {
  dot.className = `dot ${online ? 'online' : 'offline'}`;
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
      rtt = performance.now() - pingSentAt;
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
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}&session=${encodeURIComponent(sessionName)}&shell=${encodeURIComponent(shell)}`;
  const ws = new WebSocket(url);
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
    handleFrame(decodeFrame(new Uint8Array(event.data)));
  };
  ws.onclose = () => {
    if (socket === ws) scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  socket = undefined;
  showStatus(false);
  const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt++);
  setTimeout(() => socket ?? connect(), backoff * (0.8 + Math.random() * 0.4));
}

function reconnectNow(): void {
  const old = socket;
  socket = undefined;
  old?.close();
  connect();
}

async function main(): Promise<void> {
  await document.fonts.load(`16px "Cascadia Mono Variable"`);
  term.open(container);
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
  term.parser.registerCsiHandler({ final: 'c' }, () => true);
  term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true);
  term.parser.registerCsiHandler({ final: 'n' }, (args) => args[0] === 5 || args[0] === 6);
  term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (args) => args[0] === 6);

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
    send({ type: 'input', data: encoder.encode(data) });
  });
  term.onTitleChange((text) => {
    title.textContent = text || `${sessionName} · ${shell}`;
  });
  title.textContent = `${sessionName} · ${shell}`;

  let resizeTimer: number | undefined;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(fitAndReport, 50);
  }).observe(container);

  setInterval(() => {
    if (!socket) return;
    if (performance.now() - lastFrameAt > DEAD_AFTER_MS) return reconnectNow();
    pingSentAt = performance.now();
    send({ type: 'ping', nonce: Math.floor(Math.random() * 0xffffffff) });
  }, PING_INTERVAL_MS);
  window.addEventListener('online', () => socket?.readyState !== WebSocket.OPEN && reconnectNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket?.readyState !== WebSocket.OPEN) reconnectNow();
  });

  connect();
  term.focus();
}

void main();
