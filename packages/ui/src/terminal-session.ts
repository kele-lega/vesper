import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { CAMPBELL } from '@vesper/protocol';
import { TerminalConnection, type ConnectionHandlers, type ConnectionState, type EndReason } from './connection.js';
import { terminalKeyInput, type TerminalKey } from './input.js';
import { OrderedTerminal } from './ordered-terminal.js';
import { guardTerminalQueries } from './query-guard.js';

const FONT_FAMILY = '"Cascadia Mono", "Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", monospace';
const RESIZE_DEBOUNCE_MS = 50;
const NOTICE_MS = 8000;
const notice = (text: string) => `\r\n\x1b[90m[${text}]\x1b[0m\r\n`;

/** What the tab bar and status line show for one session. */
export interface SessionView {
  state: ConnectionState;
  status: string;
  ended?: EndReason;
}

export interface SessionOptions {
  /** The pty server's platform, not the browser's operating system. */
  platform?: string;
  /** Agent CLIs read ESC CR as "new line, don't send"; Shift+Enter types it. */
  agent?: boolean;
}

/** Keys the page handles (by physical key, so layouts and Shift do not matter); xterm must not turn them into input. */
export function isPageShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.code === 'Tab') return true;
  return event.shiftKey && ['KeyT', 'KeyW', 'KeyF'].includes(event.code);
}

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
    const median = this.median();
    if (median === undefined) return '回显 –';
    return `回显 ${this.samples.at(-1)!.toFixed(1)}ms · 中位 ${median.toFixed(1)}ms（${this.samples.length} 次）`;
  }
}

/**
 * One tab's terminal: an xterm and its connection. Only the tab in front holds
 * a WebGL context (browsers allow few) and an open socket.
 */
export class TerminalSession {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly latency = new LatencyMeter();
  private readonly connection: TerminalConnection;
  private readonly stopResize: () => void;
  private webgl: WebglAddon | undefined;
  private view: SessionView = { state: 'connecting', status: '连接中…' };
  private rtt: number | undefined;
  private message: { text: string; until: number } | undefined;
  private pendingInputAt: number | undefined;
  private started = false;
  private active = false;

  constructor(
    sessionId: string,
    private readonly container: HTMLElement,
    private readonly onChange: (view: SessionView) => void,
    options: SessionOptions = {},
  ) {
    this.term = new Terminal({
      fontFamily: FONT_FAMILY, fontSize: 16, lineHeight: 1, letterSpacing: 0,
      cursorStyle: 'bar', cursorBlink: true, scrollback: 9001, theme: { ...CAMPBELL },
      allowProposedApi: true,
      ...(options.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: 19045 } } : {}),
    });
    this.term.open(container);
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon());
    this.term.loadAddon(this.search);
    // OSC 52: programs (vim, tmux, ssh sessions) can put text on this device's clipboard.
    this.term.loadAddon(new ClipboardAddon());
    // The pty host answers terminal queries; replies from each attached browser would reach the shell as typed input.
    guardTerminalQueries(this.term.parser);
    this.connection = new TerminalConnection(sessionId, this.handlers(new OrderedTerminal(this.term)), () => this.fit.proposeDimensions());
    installInput(this.term, options.agent ?? false, (text) => {
      this.pendingInputAt ??= performance.now();
      this.connection.input(text);
    });
    this.stopResize = installResize(container, this.fit, (cols, rows) => this.connection.resize(cols, rows));
  }

  /** Brings the tab to the front: its container must already be visible. Does nothing if it is in front. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.loadWebgl();
    if (this.started) this.connection.resume();
    else this.connection.start();
    this.started = true;
    exposeForTests(this.term, this.latency);
    this.term.focus();
  }

  /** Touch keys enter through onData, just like the physical keyboard and pasted text. */
  sendKey(key: TerminalKey): void {
    if (!this.active || this.view.ended) return;
    this.term.input(terminalKeyInput(key, this.term.modes.applicationCursorKeysMode));
  }

  /** Called within the keyboard button's user gesture so mobile browsers may open the keyboard. */
  focus(): void {
    if (this.active) this.term.focus();
  }

  /** Finds `text` searching up (previous) or down from the current match; false when nothing matches. */
  find(text: string, backwards = false): boolean {
    if (text === '') {
      this.search.clearDecorations();
      return false;
    }
    const options = { decorations: { matchOverviewRuler: '#888888', activeMatchColorOverviewRuler: '#f9f1a5', activeMatchBackground: '#715d00' } };
    return backwards ? this.search.findPrevious(text, options) : this.search.findNext(text, options);
  }

  endFind(): void {
    this.search.clearDecorations();
    this.term.clearSelection();
    this.term.focus();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.webgl?.dispose();
    this.webgl = undefined;
    this.connection.pause();
  }

  dispose(): void {
    this.stopResize();
    this.connection.dispose();
    this.term.dispose();
  }

  private handlers(screen: OrderedTerminal): ConnectionHandlers {
    return {
      snapshot: (frame, parsed) => screen.replace(frame.cols, frame.rows, frame.data, parsed),
      output: (data, parsed) => {
        const startedAt = this.pendingInputAt;
        this.pendingInputAt = undefined;
        screen.write(data, () => {
          parsed();
          if (startedAt !== undefined) requestAnimationFrame(() => this.recordEcho(performance.now() - startedAt));
        });
      },
      size: (cols, rows) => screen.resize(cols, rows),
      exit: (code) => screen.write(notice(`进程已退出，代码 ${code}`)),
      state: (state, detail) => {
        if (detail.rtt !== undefined) this.rtt = detail.rtt;
        this.update({ state });
      },
      dropped: (count, reason) =>
        this.say(reason === 'stale' ? `断线超过 5 秒，期间输入的 ${count} 段按键没有发送` : `程序已重新启动，断线期间输入的 ${count} 段按键没有发送`),
      ended: (reason) => this.update({ state: 'offline', ended: reason }),
    };
  }

  private recordEcho(ms: number): void {
    this.latency.record(ms);
    this.update({});
  }

  private say(text: string): void {
    this.message = { text, until: Date.now() + NOTICE_MS };
    this.update({});
    setTimeout(() => this.update({}), NOTICE_MS + 50);
  }

  private update(changes: Partial<SessionView>): void {
    const next = { ...this.view, ...changes };
    this.view = { ...next, status: this.describe(next) };
    // Lets scripts and styles see the connection without reading the status text.
    this.container.dataset['state'] = next.ended ? 'ended' : next.state;
    this.onChange(this.view);
  }

  private describe({ state, ended }: SessionView): string {
    if (ended) return ended === 'removed' ? '会话已关闭' : '登录已失效，请重新登录';
    if (this.message && this.message.until > Date.now()) return this.message.text;
    if (state === 'offline') return '连接已断开，正在重连…';
    if (state === 'connecting') return '连接中…';
    return this.latency.describe() + (this.rtt === undefined ? '' : ` · 心跳 ${this.rtt.toFixed(1)}ms`);
  }

  private loadWebgl(): void {
    if (this.webgl) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.webgl === webgl) this.webgl = undefined;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch (error) {
      console.warn('WebGL unavailable, falling back to the DOM renderer', error);
    }
  }
}

function installInput(term: Terminal, agent: boolean, send: (text: string) => void): void {
  term.attachCustomKeyEventHandler((event) => {
    if (isPageShortcut(event)) return false; // the page's listener on window acts on it
    if (agent && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey) {
      if (event.type === 'keydown') send('\x1b\r');
      return false;
    }
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
 * Reports the size this tab could show. The session follows the device that
 * typed last, so the terminal itself is resized only by the server's size frames.
 * A hidden tab measures nothing, so it reports nothing.
 */
function installResize(container: HTMLElement, fit: FitAddon, report: (cols: number, rows: number) => void): () => void {
  let timer: number | undefined;
  let last = '';
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const size = fit.proposeDimensions();
      if (!size || `${size.cols}x${size.rows}` === last) return;
      last = `${size.cols}x${size.rows}`;
      report(size.cols, size.rows);
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(container);
  return () => {
    clearTimeout(timer);
    observer.disconnect();
  };
}

/** End-to-end tests read the front tab's screen through this; only enabled by a flag in localStorage. */
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
