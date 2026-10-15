import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { CAMPBELL, type SessionInfo } from '@vesper/protocol';
import { api } from './api.js';
import { TerminalConnection, type ConnectionHandlers, type ConnectionState } from './connection.js';
import { byId } from './dom.js';
import { OrderedTerminal } from './ordered-terminal.js';
import { guardTerminalQueries } from './query-guard.js';

const FONT_FAMILY = '"Cascadia Mono Variable", "Cascadia Mono", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", monospace';
const RESIZE_DEBOUNCE_MS = 50;
const NOTICE_MS = 8000;
const notice = (text: string) => `\r\n\x1b[90m[${text}]\x1b[0m\r\n`;

/** Echo latency samples, from keypress to the frame that paints the echo. */
class LatencyMeter {
  private readonly samples: number[] = [];

  record(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > 200) this.samples.shift();
  }

  median(): number | undefined {
    if (this.samples.length === 0) return undefined;
    return [...this.samples].sort((a, b) => a - b)[Math.floor(this.samples.length / 2)];
  }

  describe(): string {
    if (this.samples.length === 0) return '回显 –';
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    return `回显 ${this.samples.at(-1)!.toFixed(1)}ms · 中位 ${median.toFixed(1)}ms（${this.samples.length} 次）`;
  }
}

/** The tab's dot and status text: connection state, echo latency and short notices. */
class StatusLine {
  private state: ConnectionState = 'connecting';
  private rtt: number | undefined;
  private message: { text: string; until: number } | undefined;

  constructor(private readonly latency: LatencyMeter) {}

  set(state: ConnectionState, rtt?: number): void {
    this.state = state;
    if (rtt !== undefined) this.rtt = rtt;
    this.render();
  }

  say(text: string, ms = NOTICE_MS): void {
    this.message = { text, until: Date.now() + ms };
    this.render();
    setTimeout(() => this.render(), ms + 50);
  }

  render(): void {
    const { state, rtt, message } = this;
    byId('dot').className = `dot ${state === 'online' ? 'online' : state === 'offline' ? 'offline' : ''}`;
    const status = byId('status');
    if (message && message.until > Date.now()) return void (status.textContent = message.text);
    const heartbeat = rtt === undefined ? '' : ` · 心跳 ${rtt.toFixed(1)}ms`;
    status.textContent = state === 'online' ? this.latency.describe() + heartbeat : state === 'offline' ? '连接已断开，正在重连…' : '连接中…';
  }
}

function setTitle(text: string): void {
  byId('title').textContent = text;
  document.title = `${text} · Vesper`;
}

/** Windows Terminal defaults: Campbell, Cascadia Mono 12pt (16px), bar cursor, 9001 lines. */
async function createTerminal(container: HTMLElement): Promise<{ term: Terminal; fit: FitAddon }> {
  await document.fonts.load('16px "Cascadia Mono Variable"');
  const term = new Terminal({
    fontFamily: FONT_FAMILY, fontSize: 16, lineHeight: 1, letterSpacing: 0,
    cursorStyle: 'bar', cursorBlink: true, scrollback: 9001, theme: { ...CAMPBELL },
    allowProposedApi: true, windowsPty: { backend: 'conpty', buildNumber: 19045 },
  });
  const fit = new FitAddon();
  term.open(container);
  loadAddons(term, fit);
  return { term, fit };
}

/** What the connection does with each frame: everything reaches the terminal in stream order. */
function screenHandlers(screen: OrderedTerminal, status: StatusLine, echo: { take(): number | undefined; record(ms: number): void }): ConnectionHandlers {
  return {
    snapshot: (frame, parsed) => screen.replace(frame.cols, frame.rows, frame.data, parsed),
    output: (data, parsed) => {
      const startedAt = echo.take();
      screen.write(data, () => {
        parsed();
        if (startedAt !== undefined) requestAnimationFrame(() => echo.record(performance.now() - startedAt));
      });
    },
    size: (cols, rows) => screen.resize(cols, rows),
    exit: (code) => screen.write(notice(`进程已退出，代码 ${code}`)),
    state: (next, detail) => status.set(next, detail.rtt),
    dropped: (count, reason) =>
      status.say(reason === 'stale' ? `断线超过 5 秒，期间输入的 ${count} 段按键没有发送` : `shell 已重新启动，断线期间输入的 ${count} 段按键没有发送`),
    ended: (reason) => {
      status.set('offline');
      status.say(reason === 'removed' ? '会话已关闭' : '访问令牌无效：请用 vesper-web 打印的链接重新打开', 1e9);
    },
  };
}

export async function showTerminal(sessionId: string): Promise<void> {
  const container = byId('terminal');
  container.hidden = false;
  const { term, fit } = await createTerminal(container);
  const latency = new LatencyMeter();
  exposeForTests(term, latency);
  const status = new StatusLine(latency);
  // Time from the first keypress to the paint of the output that follows it.
  let pendingInputAt: number | undefined;
  const echo = {
    take: () => {
      const startedAt = pendingInputAt;
      pendingInputAt = undefined;
      return startedAt;
    },
    record: (ms: number) => {
      latency.record(ms);
      status.render();
    },
  };
  const connection = new TerminalConnection(sessionId, screenHandlers(new OrderedTerminal(term), status, echo), () => fit.proposeDimensions());
  installInput(term, (text) => {
    pendingInputAt ??= performance.now();
    connection.input(text);
  });
  installResize(container, fit, (cols, rows) => connection.resize(cols, rows));
  term.onTitleChange((text) => text && setTitle(text));
  void api<{ session: SessionInfo }>('GET', `/api/sessions/${encodeURIComponent(sessionId)}`).then(
    ({ session }) => setTitle(session.title),
    () => setTitle('Vesper'),
  );
  connection.start();
  term.focus();
}

function loadAddons(term: Terminal, fit: FitAddon): void {
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

function installInput(term: Terminal, send: (text: string) => void): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey) return true;
    if (event.key === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    return event.key !== 'v'; // let the browser paste; xterm turns the paste event into input
  });
  term.onData(send);
}

/**
 * Reports the size this window could show. The session follows the device that
 * typed last, so the terminal itself is resized only by the server's size frames.
 */
function installResize(container: HTMLElement, fit: FitAddon, report: (cols: number, rows: number) => void): void {
  let timer: number | undefined;
  let last = '';
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const size = fit.proposeDimensions();
      if (!size || `${size.cols}x${size.rows}` === last) return;
      last = `${size.cols}x${size.rows}`;
      report(size.cols, size.rows);
    }, RESIZE_DEBOUNCE_MS);
  }).observe(container);
}

/** End-to-end tests read the screen through this; only enabled by a flag in localStorage. */
function exposeForTests(term: Terminal, latency: LatencyMeter): void {
  if (localStorage.getItem('vesper-debug') !== '1') return;
  const lines = () => {
    const buffer = term.buffer.active;
    const out: string[] = [];
    for (let row = 0; row < buffer.length; row++) out.push(buffer.getLine(row)?.translateToString(true) ?? '');
    return out.join('\n');
  };
  /** The visible rows, trailing blanks trimmed (ConPTY paints empty rows with spaces). */
  const visible = () => {
    const buffer = term.buffer.active;
    const out: string[] = [];
    for (let row = 0; row < term.rows; row++) out.push((buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').trimEnd());
    return out.join('\n').trimEnd();
  };
  Object.assign(window, { vesperTerminal: { text: lines, screen: visible, size: () => ({ cols: term.cols, rows: term.rows }), echoMedian: () => latency.median() } });
}
